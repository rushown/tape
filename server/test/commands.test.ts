import { describe, expect, it } from 'vitest'
import { normalize, parse, wordsToDigits } from '../src/commands.js'

describe('normalize', () => {
  it('turns spoken numbers and money into digits', () => {
    expect(wordsToDigits('ninety thousand')).toBe('90000')
    expect(wordsToDigits('zero point zero one')).toBe('0.01')
    expect(wordsToDigits('one hundred and fifty')).toBe('150')
    expect(wordsToDigits('a thousand')).toBe('1000')
    expect(normalize('Buy $500 of ETH.')).toBe('buy 500 usd of eth')
    expect(normalize('BTC below 90k')).toBe('btc below 90000')
    expect(normalize('below 90,000')).toBe('below 90000')
    expect(normalize('P&L below minus 200')).toBe('pnl below -200')
  })
})

describe('parse', () => {
  const cases: Array<[string, unknown]> = [
    ['Buy 0.01 BTC.', { kind: 'order', side: 'buy', coin: 'BTC', qty: 0.01 }],
    ['buy zero point zero one bitcoin at market', { kind: 'order', side: 'buy', coin: 'BTC', qty: 0.01 }],
    ['Short 2 ETH at 3,200', { kind: 'order', side: 'sell', coin: 'ETH', qty: 2, price: 3200 }],
    ['Long $500 of Solana', { kind: 'order', side: 'buy', coin: 'SOL', usd: 500 }],
    ['go long ethereum for 300 dollars', { kind: 'order', side: 'buy', coin: 'ETH', usd: 300 }],
    ['sell 10 sol at 150', { kind: 'order', side: 'sell', coin: 'SOL', qty: 10, price: 150 }],
    ['Close my BTC position', { kind: 'close', coin: 'BTC', fraction: 1 }],
    ['close half of ETH', { kind: 'close', coin: 'ETH', fraction: 0.5 }],
    ['take profit on 25% of sol', { kind: 'close', coin: 'SOL', fraction: 0.25 }],
    ['Close everything', { kind: 'close_all' }],
    ['flatten', { kind: 'close_all' }],
    ['close all of my ETH', { kind: 'close', coin: 'ETH', fraction: 1 }],
    ['cancel my orders', { kind: 'cancel_orders' }],
    ['Move 500 USDT from funding to trading', { kind: 'transfer', amount: 500, from: 'funding', to: 'trading' }],
    ['Move $500 from spot to margin', { kind: 'transfer', amount: 500, from: 'funding', to: 'trading' }],
    ['transfer 200 to my funding wallet', { kind: 'transfer', amount: 200, from: 'trading', to: 'funding' }],
    ['Alert me if Bitcoin drops below 90k', { kind: 'alert', target: 'price', coin: 'BTC', op: 'below', value: 90000 }],
    ['tell me when sol hits 150', { kind: 'alert', target: 'price', coin: 'SOL', value: 150 }],
    ['alert if ETH drops 5%', { kind: 'alert', target: 'price', coin: 'ETH', op: 'below', value: 0, relativePct: -5 }],
    ['Alert if PnL is below minus 200', { kind: 'alert', target: 'pnl', op: 'below', value: -200 }],
    ["warn me if I'm down 300", { kind: 'alert', target: 'pnl', op: 'below', value: -300 }],
    ['clear my alerts', { kind: 'clear_alerts' }],
    ['What is TON at?', { kind: 'price', coin: 'TON' }],
    ['how am I doing', { kind: 'portfolio' }],
    ['watch solana', { kind: 'focus', coin: 'SOL' }],
  ]
  it.each(cases)('%s', (text, want) => {
    expect(parse(text)).toEqual(want)
  })

  it('asks instead of guessing', () => {
    expect(parse('buy bitcoin').kind).toBe('unknown')
    expect(parse('buy some').kind).toBe('unknown')
    expect(parse('hello there').kind).toBe('unknown')
    expect(parse('alert me').kind).toBe('unknown')
  })
})
