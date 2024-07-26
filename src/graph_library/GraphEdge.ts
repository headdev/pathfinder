import GraphVertex from "./GraphVertex"
import { DEX, MIN_TVL, SLIPPAGE, LENDING_FEE, MINPROFIT, QUOTER_CONTRACT_ADDRESS } from '../constants';

// https://github.com/trekhleb/javascript-algorithms/blob/master/src/data-structures/graph/GraphEdge.js

export interface EdgeMetadata {
  dex: DEX;
  address: string;
  fee: number;
  liquidity?: string;
  feeTier?: number;
}

export default class GraphEdge {
  startVertex: GraphVertex;
  endVertex: GraphVertex;
  weight: number;
  rawWeight: number;
  metadata: EdgeMetadata;

  constructor(startVertex: GraphVertex, endVertex: GraphVertex, weight = 0, rawWeight = 0, metadata: EdgeMetadata) {
    this.startVertex = startVertex;
    this.endVertex = endVertex;
    this.weight = weight;
    this.rawWeight = rawWeight;
    this.metadata = metadata;
  }
  
    /**
     * @return {string}
     */
    getKey() {
      const startVertexKey = this.startVertex.getKey();
      const endVertexKey = this.endVertex.getKey();
  
      return `${startVertexKey}_${endVertexKey}`;
    }
  
    /**
     * @return {GraphEdge}
     */
    reverse() {
      const tmp = this.startVertex;
      this.startVertex = this.endVertex;
      this.endVertex = tmp;
  
      return this;
    }
  
    /**
     * @return {string}
     */
    toString() {
      return this.getKey();
    }
  }