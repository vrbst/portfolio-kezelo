import type { Account, AccountKind, InstrumentType, TxType } from './model'

export function accountKindLabel(account: Account): string {
  if (account.kind === 'tbsz') {
    return account.tbszYear ? `TBSZ ${account.tbszYear}` : 'TBSZ'
  }
  const map: Record<AccountKind, string> = {
    tbsz: 'TBSZ',
    treasury: 'Államkincstár',
    regular: 'Befektetési',
    cash: 'Pénzszámla',
  }
  return map[account.kind]
}

export const txTypeLabel: Record<TxType, string> = {
  buy: 'Vétel',
  sell: 'Eladás',
  deposit: 'Befizetés',
  withdrawal: 'Kifizetés',
  conversion: 'Átváltás',
  fee: 'Díj',
  interest: 'Kamat',
  redemption: 'Beváltás',
  tax: 'Adó',
  dividend: 'Osztalék',
  transfer: 'Utalás',
}

export const instrumentTypeLabel: Record<InstrumentType, string> = {
  etf: 'ETF',
  stock: 'Részvény',
  gov_bond: 'Állampapír',
  tbill: 'Diszkont kincstárjegy',
  fund: 'Alap',
  cash: 'Készpénz',
}
