import { gql } from 'graphql-request'




export const ENDPOINT = `https://gateway-arbitrum.network.thegraph.com/api/6842087090c3e66bac508150e15a17a9/subgraphs/id/8NiXkxLRT3R22vpwLB4DXttpEf3X1LrKhe4T1tQ3jjbP
`;

export function PAIR(id) {
    return gql`
      {
        pair(id: "${id}") {
          token0 { id, symbol }
          token1 { id, symbol }
          token0Price
          token1Price
          reserveUSD
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