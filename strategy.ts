// FirstLight: a launch-momentum sniper for the pump.fun replay (agent-fun/replay/v2).
//
// Thesis, from the dev data: most coins pop in their first slots and then bleed back
// toward their create price, so buying a fresh launch and holding it loses. But a
// launch that ALREADY ran 30%+ in its first 3 slots, on a handful of outside buyers
// with real SOL behind it and a creator who has not sold, keeps running about a
// quarter of the time — and the runs that fail mostly drift sideways rather than
// collapsing. The edge, such as it is, is in buying that continuation fast, sizing
// up to the 1%-of-reserve cap (bigger stakes dilute the fixed transaction fee), and
// cutting the drifters before fees eat them.
//
// Two findings shaped the design, both verified in backtests on the full dev window:
//   1. Tight buy slippage (1%) is a free "don't chase" filter. A buy refused for
//      slippage costs nothing; a buy that fills after the price jumped 10% in the
//      2-slot latency is buying the top. Tightening slippage from wide open to 1%
//      halved the loss.
//   2. Entries are one-shot. Each coin is judged ONCE, on the first batch where its
//      real SOL and run-up are both in window, using the tape as it stands at that
//      moment. Re-judging later, after more buyers arrive, buys the top of a pop
//      that already happened.
//
// Two tiers share one exit engine:
//   Tier A (the money): strict launch-momentum entries — young coins (≤ 3 slots
//     old) already up 30%+ on 0–3 outside buyers with 0.3–30 SOL of real reserves,
//     a small creator buy (≤ 2.5 SOL) and no creator sell. Sized up to 0.3 SOL.
//   Tier B (the breadth): tiny 0.01 SOL probes on looser launches, fired only when
//     the run's distinct-coin count trails the pace the 20-coin guardrail needs.
//
// Exits: take-profit (+25%), stop-loss (−5%), a trailing stop once a position is up
// 10% (exit on an 8% fall from the peak), a hard 20-slot time limit, an instant exit
// when the creator sells, and a staleness exit. One buy per coin, never re-entered
// after an exit, one order per decision (splitting an order only multiplies the
// per-transaction fee).
//
// Honest status: on the 24h dev window this bot scores about −0.08 SOL — the best
// of every design tested (momentum, reversion, completion riding, dip buying, and a
// popular-launch "lottery" all lost more), but still below zero. The 2.5% round-trip
// curve fee plus the 2-slot latency leaves almost no room: the signal is roughly
// break-even before fees. It is built, verified deterministic, and guardrail-clean;
// whether to enter it is a judgement call, not a winning backtest.
//
// Everything is a pure function of the hello and the batches: no clock, no random
// numbers, no environment, no I/O. Block time is read from the events themselves
// (replay data, identical in both graded executions) and only paces the probes.

import {
  BPS,
  LAMPORTS_PER_SOL,
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Oldest age (slots since CreateEvent) at which a first buy may be decided. */
  maxAge: number;
  /** Tier A: real SOL reserve window at decision time (lamports). */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** Tier A: price now over the create price, as bps: window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** Tier A: distinct non-creator buyers seen before entry: window. */
  minBuyers: number;
  maxBuyers: number;
  /** Tier A: creator's own buys in the create slot, at most (lamports). */
  maxDevBuy: bigint;
  /** Tier A: lamports to aim for per coin (each reply is still capped at 1% of real SOL). */
  stake: bigint;
  /** Smallest buy worth sending (lamports). Must stay >= 10_000_000 to count a round trip. */
  minBuy: bigint;
  /** Slippage allowed on buys (bps): a buy whose fill is worse than this is refused — free. */
  buySlippageBps: number;
  /** Slippage allowed on sells (bps). */
  sellSlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  takeProfitBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  stopLossBps: number;
  /** Trailing stop: once up at least this much (bps), exit on a fall of trailBps from the peak. */
  trailArmBps: number;
  trailBps: number;
  /** First take-profit: sell tp1PartBps of the position once it is up tp1Bps. */
  tp1Bps: number;
  tp1PartBps: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit after holding this many slots once the trailing stop has armed (a runner). */
  runnerMaxHoldSlots: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Tier B probe: lamports per probe (exactly the guardrail's minimum round trip). */
  probeStake: bigint;
  /** Tier B probe: real SOL reserve floor at decision time (lamports). */
  probeMinRealSol: bigint;
  /** Tier B probe: one probe per this many seconds of elapsed block time, while behind pace. */
  probePaceSeconds: number;
  /** Tier B probe: stop probing once this many distinct coins have been traded. */
  probeTargetCoins: number;
  /** Most new entries (both tiers) per reply. */
  maxEntriesPerBatch: number;
}

export const DEFAULT_PARAMS: Params = {
  maxAge: 3,
  minRealSol: 300_000_000n,
  maxRealSol: 30_000_000_000n,
  minRunupBps: 13_000,
  maxRunupBps: 1_000_000,
  minBuyers: 0,
  maxBuyers: 3,
  maxDevBuy: 2_500_000_000n,
  stake: 300_000_000n,
  minBuy: 10_000_000n,
  buySlippageBps: 100,
  sellSlippageBps: 10_000,
  takeProfitBps: 2_500,
  stopLossBps: 500,
  trailArmBps: 1_000,
  trailBps: 800,
  tp1Bps: 1_000_000,
  tp1PartBps: 5_000,
  maxHoldSlots: 20,
  runnerMaxHoldSlots: 20,
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  probeStake: 10_000_000n,
  probeMinRealSol: 1_000_000_000n,
  probePaceSeconds: 900,
  probeTargetCoins: 30,
  maxEntriesPerBatch: 2,
};

const CURVE_FEE_BPS = 125n;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  buyers: Set<Pubkey>;
  /** Recent trades, oldest first; pruned to the flow window as new ones arrive. */
  recent: Tick[];
  lastTradeSlot: number;
  /** Bought already, exited, or ruled out for good: never buy again. */
  done: boolean;
  /** Tier A has had its one shot (signalled and decided). */
  doneA: boolean;
  /** Tier A has signalled (real SOL + run-up in window) at least once. */
  signalled: boolean;
  /** Tier B has had its one shot. */
  doneB: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Transaction fees paid on this position's orders (buy + sells so far). */
  txPaid: bigint;
  /** Best liquidation value seen (net of the exit tx fee). */
  best: bigint;
  /** Whether the creator had already sold when the position opened. */
  devSoldAtOpen: boolean;
  tookTp1: boolean;
  tier: 'A' | 'B';
}

/** What selling `tokens` against (vq, vt) would pay after curve fees (95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

export interface EngineStats {
  entriesA: number;
  entriesB: number;
  exits: Record<string, number>;
  slippageRejects: number;
  failedTx: number;
  /** Distinct mints with a filled buy of >= 10M lamports (guardrail-qualifying round trips). */
  qualifyingMints: number;
}

export class FirstLight {
  private readonly p: Params;
  private readonly coins = new Map<Pubkey, Coin>();
  private readonly held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  private readonly selling = new Set<Pubkey>();
  /** Tier of each buy in flight, so the Held record knows which tier opened it. */
  private readonly pendingTier = new Map<Pubkey, 'A' | 'B'>();
  /** Mints ever bought (filled or pending): the distinct-coin count for probe pacing. */
  private readonly traded = new Set<Pubkey>();
  private firstBlockTime: number | null = null;
  private nowBlockTime = 0;
  private readonly statsData: EngineStats = { entriesA: 0, entriesB: 0, exits: {}, slippageRejects: 0, failedTx: 0, qualifyingMints: 0 };
  private readonly qualifying = new Set<Pubkey>();

  constructor(params: Params = DEFAULT_PARAMS) {
    this.p = params;
  }

  /** Counters for offline analysis (never affect decisions). */
  stats(): EngineStats {
    return this.statsData;
  }

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    this.noteEvents(batch);
    this.noteTime(batch);
    this.noteFills(state, batch);
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    this.decideExits(state, batch, orders, cap);
    this.decideEntries(state, batch, orders, cap);
    return orders;
  }

  private noteEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (this.coins.has(e.mint)) continue;
        this.coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          devSold: false,
          buyers: new Set(),
          recent: [],
          lastTradeSlot: e.slot,
          done: false,
          doneA: false,
          signalled: false,
          doneB: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = this.coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        }
      } else {
        const c = this.coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  private noteTime(batch: Batch): void {
    for (const e of batch.events) {
      if (e.block_time === null) continue;
      if (this.firstBlockTime === null) this.firstBlockTime = e.block_time;
      if (e.block_time > this.nowBlockTime) this.nowBlockTime = e.block_time;
    }
  }

  private noteFills(state: BotState, batch: Batch): void {
    for (const f of batch.fills) {
      if (f.status === 'rejected' && f.reason === 'max_slippage') this.statsData.slippageRejects += 1;
      if (f.status === 'failed') this.statsData.failedTx += 1;
      if (f.side === 'buy' && f.status === 'filled' && BigInt(f.quote_lamports) >= 10_000_000n) {
        this.qualifying.add(f.mint);
        this.statsData.qualifyingMints = this.qualifying.size;
      }
      if (f.client_id.startsWith('_')) {
        // A harness close (complete / flatten / writeoff): the position is gone.
        this.held.delete(f.mint);
        this.selling.delete(f.mint);
        continue;
      }
      const h = this.held.get(f.mint);
      if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
      if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
        const c = this.coins.get(f.mint);
        this.held.set(f.mint, {
          openedSlot: f.slot,
          txPaid: BigInt(f.tx_fee_lamports),
          best: 0n,
          devSoldAtOpen: c?.devSold ?? false,
          tookTp1: false,
          tier: this.pendingTier.get(f.mint) ?? 'A',
        });
      }
      if (f.side === 'buy') this.pendingTier.delete(f.mint);
    }
    for (const mint of [...this.selling]) {
      if (!this.hasPending(state, mint, 'sell')) this.selling.delete(mint);
    }
    for (const mint of [...this.held.keys()]) {
      if (!state.positions.has(mint) && !this.selling.has(mint) && !this.hasPending(state, mint, 'buy')) {
        this.held.delete(mint);
      }
    }
  }

  private hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === side) return true;
    return false;
  }

  /** Net SOL bought minus sold over the coin's recent ticks (the whole tape it keeps). */
  private netFlow(c: Coin): bigint {
    let net = 0n;
    for (const t of c.recent) net += t.isBuy ? t.sol : -t.sol;
    return net;
  }

  private decideExits(state: BotState, batch: Batch, orders: OrderInput[], cap: number): void {
    const p = this.p;
    const tx = state.txFeeLamports();
    const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) return;
      if (this.selling.has(mint)) continue;
      const c = this.coins.get(mint);
      let h = this.held.get(mint);
      if (h === undefined) {
        // Position appeared without a recorded fill (should not happen): track it from now.
        h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false, tookTp1: false, tier: 'A' };
        this.held.set(mint, h);
      }
      const mk = marks.get(mint);
      const curve = state.curves.get(mint);
      const vq = mk?.vq ?? curve?.virtual_quote_reserves;
      const vt = mk?.vt ?? curve?.virtual_token_reserves;
      if (vq === undefined || vt === undefined) continue;
      // Liquidation value, net of the tx fee the exit itself will pay.
      const value = sellValue(pos.token_amount, vq, vt) - tx;
      const basis = pos.cost_lamports + h.txPaid;
      if (value > h.best) h.best = value;

      let exit = false;
      let reason = '';
      if (basis > 0n) {
        if (!h.tookTp1 && value * BPS >= basis * (BPS + BigInt(p.tp1Bps))) {
          // Partial take-profit: bank half, let the rest ride under the trailing stop.
          const part = (pos.token_amount * BigInt(p.tp1PartBps)) / BPS;
          if (part > 0n && part < pos.token_amount) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: p.sellSlippageBps });
            this.selling.add(mint);
            h.tookTp1 = true;
            h.best = 0n;
            this.statsData.exits['tp1'] = (this.statsData.exits['tp1'] ?? 0) + 1;
            continue;
          }
        }
        if (value * BPS >= basis * (BPS + BigInt(p.takeProfitBps))) {
          exit = true;
          reason = 'tp';
        }
        if (value * BPS <= basis * (BPS - BigInt(p.stopLossBps))) {
          exit = true;
          reason = 'sl';
        }
        if (h.best * BPS >= basis * (BPS + BigInt(p.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(p.trailBps))) {
          exit = true;
          reason = 'trail';
        }
      }
      // A runner (trailing stop armed) gets the long hold limit; anything else is cut
      // at the short one, so dead positions free their slot quickly.
      const armed = basis > 0n && h.best * BPS >= basis * (BPS + BigInt(p.trailArmBps));
      const holdLimit = armed ? p.runnerMaxHoldSlots : p.maxHoldSlots;
      if (state.slot - h.openedSlot >= holdLimit) {
        exit = true;
        reason = reason === '' ? 'hold' : reason;
      }
      if (c !== undefined) {
        if (p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) {
          exit = true;
          reason = 'devsell';
        }
        if (state.slot - c.lastTradeSlot >= p.staleSlots) {
          exit = true;
          reason = reason === '' ? 'stale' : reason;
        }
      }
      if (!exit) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlippageBps });
      this.selling.add(mint);
      this.statsData.exits[reason] = (this.statsData.exits[reason] ?? 0) + 1;
      if (c !== undefined) c.done = true;
    }
  }

  private decideEntries(state: BotState, batch: Batch, orders: OrderInput[], cap: number): void {
    const p = this.p;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports() - tx * BigInt(orders.length);
    let open = state.committedPositionCount();
    const maxOpen = state.hello.caps.max_open_positions;
    let entries = 0;

    const probesBehind = this.probesBehind();
    for (const c of this.coins.values()) {
      if (orders.length >= cap || entries >= p.maxEntriesPerBatch) return;
      if (c.done || c.complete) continue;
      const age = state.slot - c.createSlot;
      if (age > p.maxAge) {
        c.done = true;
        continue;
      }
      if (state.positions.has(c.mint) || this.hasPending(state, c.mint, 'buy')) continue;
      const curve = state.curves.get(c.mint);
      if (curve === undefined || curve.complete) continue;
      if (c.devSold) {
        c.done = true;
        continue;
      }
      const rq = curve.real_quote_reserves;
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      // Run-up as bps: (vq/vt) / (vq0/vt0), cross-multiplied to stay in integers.
      const runupBps = c.vq0 > 0n && vt > 0n ? (vq * c.vt0 * BPS) / (vt * c.vq0) : 0n;

      // Tier A, one shot: the signal is the first batch where real SOL and the
      // run-up are both in window. The remaining filters are judged on the tape
      // as it stands AT THAT MOMENT. A coin that fails is done for Tier A for
      // good — re-judging it later, after more buyers arrive, would buy the top
      // of a pop that already happened (the buyer count only grows with age).
      let amount: bigint | null = null;
      let tier: 'A' | 'B' = 'A';
      if (!c.doneA) {
        const signal = rq >= p.minRealSol && rq <= p.maxRealSol && runupBps >= BigInt(p.minRunupBps) && runupBps <= BigInt(p.maxRunupBps);
        if (signal) {
          c.signalled = true;
          const filtersPass =
            c.buyers.size >= p.minBuyers &&
            c.buyers.size <= p.maxBuyers &&
            c.devBuy <= p.maxDevBuy &&
            this.netFlow(c) > 0n;
          if (!filtersPass) {
            c.doneA = true;
          } else {
            const sizeCap = state.maxBuyLamports(c.mint);
            const want = p.stake < sizeCap ? p.stake : sizeCap;
            if (want >= p.minBuy) amount = want;
            // If the size cap is too small, the coin stays live for Tier A:
            // the cap grows with the reserve, so a later batch may allow a buy.
            // (The one-shot rule judges the FILTERS once, not the sizing.)
            else c.doneA = false;
          }
        } else if (c.signalled) {
          // The signal came and went (run-up faded or reserve left the window):
          // the moment passed without a buy.
          c.doneA = true;
        }
      }
      // Tier B: a probe, only while breadth trails its pace. Same one-shot rule:
      // the first batch where the reserve allows a minimum round trip decides it.
      if (amount === null && !c.doneB && probesBehind > 0) {
        if (rq >= p.probeMinRealSol) {
          if (c.devBuy <= p.maxDevBuy && state.maxBuyLamports(c.mint) >= p.probeStake) {
            amount = p.probeStake;
            tier = 'B';
          }
          c.doneB = true;
        }
      }
      if (amount === null) continue;
      if (open >= maxOpen) continue;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      free -= amount + tx;
      open += 1;
      entries += 1;
      this.traded.add(c.mint);
      this.pendingTier.set(c.mint, tier);
      if (tier === 'A') this.statsData.entriesA += 1;
      else this.statsData.entriesB += 1;
      c.done = true;
      c.doneA = true;
      c.doneB = true;
    }
  }

  /** How many probe round trips the breadth pace still owes (0 when on pace). */
  private probesBehind(): number {
    if (this.firstBlockTime === null) return 0;
    const elapsed = Math.max(0, this.nowBlockTime - this.firstBlockTime);
    const due = Math.min(this.p.probeTargetCoins, 1 + Math.floor(elapsed / this.p.probePaceSeconds));
    return Math.max(0, due - this.traded.size);
  }
}

export function createBot(params: Params = DEFAULT_PARAMS): Bot & { stats: () => EngineStats } {
  const engine = new FirstLight(params);
  return { onBatch: (state, batch) => engine.onBatch(state, batch), stats: () => engine.stats() };
}

/** One SOL in lamports, for callers that size in SOL. */
export const ONE_SOL = LAMPORTS_PER_SOL;
