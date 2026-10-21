import { address, type Address } from '@solana/kit'
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'

export const TOKEN_2022_PROGRAM_ADDRESS = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

export type Cluster = 'devnet' | 'mainnet'

export interface PaymentToken {
  symbol: string
  mint: Address
  decimals: number
  /** Owning token program. PYUSD lives on Token-2022, USDC on the classic Token program. */
  tokenProgram: Address
}

export const TOKENS: Record<Cluster, Record<'USDC' | 'PYUSD', PaymentToken>> = {
  devnet: {
    USDC: {
      symbol: 'USDC',
      mint: address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
      decimals: 6,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    },
    PYUSD: {
      symbol: 'PYUSD',
      mint: address('CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM'),
      decimals: 6,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    },
  },
  mainnet: {
    USDC: {
      symbol: 'USDC',
      mint: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      decimals: 6,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    },
    PYUSD: {
      symbol: 'PYUSD',
      mint: address('2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'),
      decimals: 6,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    },
  },
}
