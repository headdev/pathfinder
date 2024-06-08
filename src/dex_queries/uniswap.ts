import { gql } from 'graphql-request'

/**
 * VARIABLES
 */
export const ENDPOINT = `https://api.studio.thegraph.com/query/70625/uniswapv3/v0.0.1`;

/**
 * QUERIES
 */
export function POOLS(first, skip = 0) { gql`
    {
        pools(first:${first}, skip: ${skip}){
          id
          token0 {
            id
            symbol
          }
          token1 {
            id
            symbol
          }
        }
      }
    `
}

export function HIGHEST_VOLUME_TOKENS(first, skip = 0, orderby = "volumeUSD", orderDirection = "desc") {
  return gql`
    {
        tokens(first: ${first}, skip: ${skip}, orderBy: ${orderby}, orderDirection:${orderDirection}) {
          id
          symbol
          name
        }
    }`
}

export function fetch_pool(id) {
  return gql`
    {
      pool(id: "${id}") {
        token0 { id, symbol }
        token1 { id, symbol }
        token0Price
        token1Price
        totalValueLockedUSD
      }
    }
  `
}

export function token_whitelist_pools(id) {
  return gql`
    {
      pools(where: { token1: "${id}" }) {
        id
        token0 {
          id
          symbol
          name
        }
        token1 {
          id
          symbol
          name
        }
      }
    }
  `
}

// export function token_whitelist_pools(id) {
//   return gql`
//     {
//       token(id: "${id}") {
//         whitelistPools {
//           id
//           token0 {
//             id
//           }
//           token1 {
//             id
//           }
//         }
//       }
//     }
//   `
// }