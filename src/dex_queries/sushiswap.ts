import { gql } from 'graphql-request'
import * as dotenv from 'dotenv';
dotenv.config();



export const ENDPOINT = `https://gateway-arbitrum.network.thegraph.com/api/${process.env.THEGRAPH_API_KEY}/subgraphs/id/CKaCne3uUUEqT7Ei9jjZbQqTLntEno9LnFa4JnsqqBma
`;

export function PAIR(id) {
    return gql`
      {
        pair(id: "${id}") {
          token0 { id, symbol }
          token1 { id, symbol }
          token0Price
          token1Price
          liquidityUSD
        }
      }
    `
}

export function PAIRS(ids) { 
    let idString = '[\"' + ids.join("\",\"") + "\"]";
    return gql`
    query {
        pairs (where: {
            token0_in: ${idString},
            token1_in: ${idString}
        },
    ) {
        id
        name
        token0 {id}
        token1 {id}
    }
    }`
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

// TODO: Need function for fetching pools - no whitelisting concept like uniV3.