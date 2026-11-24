// Pump.fun Paper Sprint — dip-bounce bot.
//
// Strategy: buy the bounce, not the top. Every curve is watched from its
// CreateEvent. The bot only buys a curve that has already pulled back from
// its recent high and is now showing fresh buy flow again: a dip of at
// least 12% off the 300-slot high, price still above 60% of that high (so the
// curve is not dead or rugged), at least 5% off the window low, and above the
// bounce window's own average price, and the last 40 slots carrying net buy
// flow of at least 0.5 SOL from at least 5 distinct wallets with the tape
// ending on a buy. No entry if the creator has sold.
// One scale-in is allowed while the bounce keeps climbing. Exits are a
// stop-loss, a two-rung take-profit ladder with a trailing stop on the
// remainder, a hard time limit, a breakdown below the dip low, a single
// large sell, or fading flow. A small pacing probe keeps the run above the
// guardrail minimums (20 coins with >= 0.01 SOL round trips) whenever the
// main strategy is behind its pace for the window.
//
// The bot reads one batch at a time and is deterministic by construction:
// no clock, no randomness, no environment; every iteration is over
// insertion-ordered maps fed by the batch stream, so two runs on the same
// window produce byte-identical action logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from "./vendor/makefun-bot.ts";

const LAMPORTS = 1e9;
/** Curve fee the replay charges on top of the tx fee (95 + 30 bps). */
const CURVE_FEE = 0.0125;

// --- entry signal -----------------------------------------------------------
/** Dip lookback, in slots. */
const DIP_WINDOW = 300;
/** Bounce-confirmation lookback, in slots. */
const BOUNCE_WINDOW = 40;
/** Youngest age (slots since create) at which a curve may be bought. */
const MIN_AGE = 900;
/** Oldest age at which a first buy may still be decided. */
const MAX_AGE = 20_000;
/** Price must have fallen at least this far below the window high. */
const MIN_DIP = 0.12;
/** Price must still be at least this share of the window high. */
const MIN_OF_HIGH = 0.6;
/** Price must sit at least this far above the window low (recovering). */
const MIN_OFF_LOW = 0.05;
/** Net buy SOL (buys minus sells) over the bounce window. */
const MIN_BOUNCE_SOL = 0.5;
/** Buy trades in the bounce window. */
const MIN_BOUNCE_BUYS = 4;
/** Distinct buying wallets in the bounce window. */
const MIN_BOUNCE_BUYERS = 5;
/** Curve real SOL bounds at entry. */
const MIN_RQ_SOL = 1.5;
const MAX_RQ_SOL = 60;
/** Exit on any single recorded sell of at least this many SOL. */
const BIG_SELL_SOL = 2.5;

// --- sizing -----------------------------------------------------------------
/** First buy of a position, in SOL. */
const INITIAL_SOL = 0.12;
/** The one scale-in buy, in SOL. */
const ADD_SOL = 0.12;
/** Most SOL into one position in total. */
const STAKE_SOL = 0.24;
/** Smallest buy worth sending (also the guardrail's round-trip floor). */
const MIN_BUY_SOL = 0.01;
/** Slippage on buys (bps); sells always go out wide open. */
const BUY_SLIP_BPS = 5000;
const SELL_SLIP_BPS = 10_000;

// --- exits ------------------------------------------------------------------
/** Sell when the close value falls this far below cost. */
const STOP_LOSS = 0.08;
/** Sell half the position once it is worth this far over its cost. */
const TP1 = 0.15;
/** Sell the rest once it is worth this far over its cost. */
const TP2 = 0.35;
/** Trailing stop on the remainder, once the value has reached cost * (1 + TRAIL_ARM). */
const TRAIL = 0.1;
const TRAIL_ARM = 0.12;
/** Exit after this many slots held... */
const MAX_HOLD = 400;
/** ...unless the position is up at least this much. */
const HOLD_IF_UP = 0.4;
/** Exit when net SOL over the fade window falls below this. */
const FADE_WINDOW = 60;
const FADE_NET_SOL = -1;
/** Slots to wait after an exit before the same curve may be bought again. */
const COOLDOWN = 300;
/** Most entries per curve over the run. */
const MAX_ENTRIES = 2;
/** Most dip-bounce positions open at once (the rest of the position cap is for probes). */
const MAX_MAIN = 4;
/** Most SOL at cost across all positions at once (a drawdown guard). */
const MAX_EXPOSURE_SOL = 5;

// --- guardrail pacing -------------------------------------------------------
/** The run must end with at least 20 coins; pace toward more. */
const TARGET_COINS = 28;
/** Seconds of block time over which the pace ramps to its full target. */
const PACE_SECS = 21_600;
/** Probe round-trip size, in SOL. */
const PROBE_SOL = 0.02;
/** Most probes in flight at once. */
const MAX_PROBES = 1;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: Pubkey | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
  devSold: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Recorded price when the first buy was decided. */
  entryPrice: number;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  /** Whether the first take-profit rung has been taken. */
  tookTp1: boolean;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
  /** Lowest price seen over the dip window at entry time. */
  dipLow: number;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight, by mint: false while buying, true once selling. */
const probes = new Map<Pubkey, boolean>();
/** The bot's own filled orders and the coins they were on (harness closes excluded). */
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

/** How far back any tape must be kept, in slots. */
const KEEP = Math.max(DIP_WINDOW, FADE_WINDOW) + 5;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, creator: null, trades: [], entries: 0, lastExit: -1e12, devSold: false };
    tapes.set(mint, t);
  }
  return t;
}

/**
 * Entry signal on a curve's tape at slot `now`, given its real SOL reserves.
 * Returns the dip low (the window low at entry time) when the signal fires,
 * so the exit logic can watch for a breakdown below it.
 */
function entrySignal(t: Tape, now: number, rqSol: number): number | null {
  if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) return null;
  if (t.created === null || now - t.created < MIN_AGE) return null;
  if (now - t.created > MAX_AGE) return null;
  if (t.devSold) return null;
  const from = now - DIP_WINDOW;
  let high = 0;
  let low = Infinity;
  let last = 0;
  for (const tr of t.trades) {
    if (tr.slot <= from) continue;
    if (tr.price > high) high = tr.price;
    if (tr.price < low) low = tr.price;
    last = tr.price;
  }
  if (high <= 0 || low === Infinity || last <= 0) return null;
  // The dip: price off the high by at least MIN_DIP, but not collapsed.
  if (last > high * (1 - MIN_DIP)) return null;
  if (last < high * MIN_OF_HIGH) return null;
  // Recovering: price off the low by at least MIN_OFF_LOW.
  if (last < low * (1 + MIN_OFF_LOW)) return null;
  // The bounce: fresh net buy flow, several buyers, tape ending on a buy,
  // and the price above the bounce window's own average — the recovery is
  // still climbing, not a single dead-cat tick.
  const bFrom = now - BOUNCE_WINDOW;
  let net = 0;
  let buys = 0;
  let lastBuy = false;
  let priceSum = 0;
  let priceCount = 0;
  const buyers = new Set<string>();
  for (const tr of t.trades) {
    if (tr.slot <= bFrom) continue;
    net += tr.buy ? tr.sol : -tr.sol;
    if (tr.buy) {
      buys++;
      buyers.add(tr.user);
    }
    priceSum += tr.price;
    priceCount++;
    lastBuy = tr.buy;
  }
  if (!lastBuy) return null;
  if (buys < MIN_BOUNCE_BUYS || buyers.size < MIN_BOUNCE_BUYERS) return null;
  if (net < MIN_BOUNCE_SOL) return null;
  if (priceCount === 0 || last < priceSum / priceCount) return null;
  return low;
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const bigSell = new Set<Pubkey>();
    const traded = new Set<Pubkey>();
    for (const f of batch.fills) {
      if (f.status === "filled" && !f.client_id.startsWith("_")) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === "CreateEvent") {
        const t = tapeOf(e.mint);
        t.created = e.slot;
        t.creator = e.creator;
      } else if (e.event === "TradeEvent") {
        const t = tapeOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
        if (!e.is_buy && sol >= BIG_SELL_SOL) bigSell.add(e.mint);
        if (!e.is_buy && t.creator !== null && e.user === t.creator) t.devSold = true;
      }
    }
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - KEEP) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }
    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;

    // Exits first: stop-loss, take-profit ladder, trailing stop, breakdown
    // below the dip low, fading flow, big single sell, and the time limit
    // (which does not apply while the position is well up).
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const t = tapeOf(mint);
          if (h.filled) t.lastExit = now;
          else t.entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const mk = marks.get(mint);
      const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
      const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
      const tokens = Number(pos.token_amount);
      const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peakValue) h.peakValue = value;
      h.lastValue = value;
      const price = vq / vt;
      const t = tapeOf(mint);
      let exit = h.exiting;
      let partial = false;
      if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && !h.tookTp1 && value >= cost * (1 + TP1)) {
        // First rung: bank half the tokens, keep the rest running.
        partial = true;
      } else if (!exit && h.tookTp1 && value >= cost * (1 + TP2)) {
        exit = true;
      }
      if (!exit && h.peakValue >= cost * (1 + TRAIL_ARM) && value < h.peakValue * (1 - TRAIL)) exit = true;
      if (!exit && price < h.dipLow * 0.98) exit = true;
      if (!exit && flow(t, now, FADE_WINDOW) < FADE_NET_SOL) exit = true;
      if (!exit && bigSell.has(mint)) exit = true;
      if (!exit && now - h.opened > MAX_HOLD && value < cost * (1 + HOLD_IF_UP)) exit = true;
      if (partial) {
        if (pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        const half = BigInt(Math.floor(tokens / 2));
        if (half <= 0n) continue;
        orders.push({ side: "sell", mint, token_amount: half, max_slippage_bps: SELL_SLIP_BPS });
        h.tookTp1 = true;
        // The remaining half gets a fresh peak to trail from.
        h.peakValue = value / 2;
        continue;
      }
      if (!exit) continue;
      h.exiting = true;
      if (pendingByMint.has(mint)) {
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === "sell") sellPending = true;
        }
        if (sellPending) continue;
      }
      if (orders.length >= cap) break;
      orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
    }

    // Probe round trips: sell the whole probe as soon as its buy has landed.
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
      if (!selling) probes.set(mint, true);
    }

    // Then entries and the one scale-in.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let mainLeft = MAX_MAIN - held.size;
    let exposure = 0;
    for (const [mint, h] of held) {
      exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
    }
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint)) continue;
      const t = tapes.get(mint)!;
      const h = held.get(mint);
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      let want: number;
      let dipLow = 0;
      if (h === undefined) {
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        if (t.entries >= MAX_ENTRIES || now - t.lastExit < COOLDOWN) continue;
        const low = entrySignal(t, now, rqSol);
        if (low === null) continue;
        dipLow = low;
        want = Math.min(INITIAL_SOL, STAKE_SOL);
      } else {
        // Scale in once, only while the bounce keeps climbing and flow stays positive.
        if (h.exiting || !h.filled || h.invested >= STAKE_SOL - MIN_BUY_SOL) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (price < h.lastAddPrice * 1.06) continue;
        if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS) continue;
        if (flow(t, now, BOUNCE_WINDOW) < 0) continue;
        if (rqSol > MAX_RQ_SOL) continue;
        want = Math.min(ADD_SOL, STAKE_SOL - h.invested);
      }
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
      let amount = Math.min(capSol, want, MAX_EXPOSURE_SOL - exposure);
      if (amount > free - tx) amount = free - tx;
      if (amount < MIN_BUY_SOL) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: "buy", mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + tx;
      exposure += amount;
      if (h === undefined) {
        held.set(mint, {
          opened: now,
          peakValue: 0,
          invested: amount,
          exiting: false,
          filled: false,
          entryPrice: price,
          lastAddPrice: price,
          tookTp1: false,
          lastValue: 0,
          dipLow,
        });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      } else {
        h.invested += amount;
        h.lastAddPrice = price;
      }
    }

    // Guardrail pacing: open a probe when the bot's coins lag the pace.
    if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      if (needCoins) {
        const minRq = (PROBE_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
          if (free < PROBE_SOL + 2 * tx) break;
          orders.push({ side: "buy", mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
          probes.set(mint, false);
          free -= PROBE_SOL + tx;
        }
      }
    }
    return orders;
  },
});
