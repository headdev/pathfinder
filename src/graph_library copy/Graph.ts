import GraphEdge from "./GraphEdge";
import GraphVertex from "./GraphVertex";

// https://github.com/trekhleb/javascript-algorithms/blob/master/src/data-structures/graph/Graph.js
export default class Graph {

    vertices = {};
    edges = {};
    isDirected: boolean = false;

    /**
     * @param {boolean} isDirected
     */
    constructor(isDirected = false) {
      this.isDirected = isDirected;
    }
  
    /**
     * @param {GraphVertex} newVertex
     * @returns {Graph}
     */
    addVertex(newVertex): Graph {
      this.vertices[newVertex.getKey()] = newVertex;
  
      return this;
    }
  
    /**
     * @param {string} vertexKey
     * @returns GraphVertex
     */
    getVertexByKey(vertexKey): GraphVertex {
      return this.vertices[vertexKey];
    }
  
    /**
     * @param {GraphVertex} vertex
     * @returns {GraphVertex[]}
     */
    getNeighbors(vertex): GraphVertex[] {
      return vertex.getNeighbors();
    }
  
    /**
     * @return {GraphVertex[]}
     */
    getAllVertices(): GraphVertex[] {
      return Object.values(this.vertices);
    }
  
    /**
     * @return {GraphEdge[]}
     */
    getAllEdges(): GraphEdge[] {
      return Object.values(this.edges);
    }
  
    /**
     * @param {GraphEdge} edge
     * @returns {Graph}
     */
    addEdge(edge: GraphEdge): Graph {
      // Try to find and end start vertices.
      let startVertex = this.getVertexByKey(edge.startVertex.getKey());
      let endVertex = this.getVertexByKey(edge.endVertex.getKey());
  
      // Insert start vertex if it wasn't inserted.
      if (!startVertex) {
        this.addVertex(edge.startVertex);
        startVertex = this.getVertexByKey(edge.startVertex.getKey());
      }
  
      // Insert end vertex if it wasn't inserted.
      if (!endVertex) {
        this.addVertex(edge.endVertex);
        endVertex = this.getVertexByKey(edge.endVertex.getKey());
      }
  
      // Check if edge has been already added.
      if (this.edges[edge.getKey()]) {
        throw new Error('Edge has already been added before');
      } else {
        this.edges[edge.getKey()] = edge;
      }
  
      // Add edge to the vertices.
      if (this.isDirected) {
        // If graph IS directed then add the edge only to start vertex.
        startVertex.addEdge(edge);
      } else {
        // If graph ISN'T directed then add the edge to both vertices.
        startVertex.addEdge(edge);
        endVertex.addEdge(edge);
      }
  
      return this;
    }
  
    /**
     * @param {GraphEdge} edge
     */
    deleteEdge(edge: GraphEdge) {
      // Delete edge from the list of edges.
      if (this.edges[edge.getKey()]) {
        delete this.edges[edge.getKey()];
      } else {
        throw new Error('Edge not found in graph');
      }
  
      // Try to find and end start vertices and delete edge from them.
      const startVertex = this.getVertexByKey(edge.startVertex.getKey());
      const endVertex = this.getVertexByKey(edge.endVertex.getKey());
  
      startVertex.deleteEdge(edge);
      endVertex.deleteEdge(edge);
    }
  
    /**
     * @param {GraphVertex} startVertex
     * @param {GraphVertex} endVertex
     * @return {(GraphEdge|null)}
     */
    findEdge(startVertex: GraphVertex, endVertex: GraphVertex): GraphEdge | undefined {
      const vertex = this.getVertexByKey(startVertex.getKey());
  
      if (!vertex) {
        return null;
      }
  
      return vertex.findEdge(endVertex);
    }
  
    /**
     * @return {number}
     */
    getWeight(): number {
      return this.getAllEdges().reduce((weight: number, graphEdge: GraphEdge) => {
        return weight + graphEdge.weight;
      }, 0);
    }
  
    /**
     * Reverse all the edges in directed graph.
     * @return {Graph}
     */
    reverse(): Graph {
      /** @param {GraphEdge} edge */
      this.getAllEdges().forEach((edge) => {
        // Delete straight edge from graph and from vertices.
        this.deleteEdge(edge);
  
        // Reverse the edge.
        edge.reverse();
  
        // Add reversed edge back to the graph and its vertices.
        this.addEdge(edge);
      });
  
      return this;
    }
  
    /**
     * @return {object}
     */
    getVerticesIndices() {
      const verticesIndices = {};
      this.getAllVertices().forEach((vertex, index) => {
        verticesIndices[vertex.getKey()] = index;
      });
  
      return verticesIndices;
    }
  
    /**
     * @return {*[][]}
     */
    getAdjacencyMatrix() {
      const vertices = this.getAllVertices();
      const verticesIndices = this.getVerticesIndices();
  
      // Init matrix with infinities meaning that there is no ways of
      // getting from one vertex to another yet.
      const adjacencyMatrix = Array(vertices.length).fill(null).map(() => {
        return Array(vertices.length).fill(Infinity);
      });
  
      // Fill the columns.
      vertices.forEach((vertex, vertexIndex) => {
        vertex.getNeighbors().forEach((neighbor) => {
          const neighborIndex = verticesIndices[neighbor.getKey()];
          adjacencyMatrix[vertexIndex][neighborIndex] = this.findEdge(vertex, neighbor).weight;
        });
      });
  
      return adjacencyMatrix;
    }
  
    /**
     * @return {string}
     */
    toString(): string {
      return Object.keys(this.vertices).toString();
    }

    /**
     * @param {GraphVertex} startVertex
     * @param {GraphVertex} endVertex
     * @param {GraphEdge} newEdge
     * @returns {Graph}
     */
    updateEdge(startVertex: GraphVertex, endVertex: GraphVertex, newEdge: GraphEdge): Graph {
        const edge = this.findEdge(startVertex, endVertex);
        if (edge) {
            // Actualizar los valores del borde existente
            edge.weight = newEdge.weight;
            edge.rawWeight = newEdge.rawWeight;
            edge.metadata = newEdge.metadata;

            // Si el grafo no es dirigido, actualizar también el borde inverso
            if (!this.isDirected) {
                const reverseEdge = this.findEdge(endVertex, startVertex);
                if (reverseEdge) {
                    reverseEdge.weight = -newEdge.weight; // El peso se invierte para el borde inverso
                    reverseEdge.rawWeight = 1 / newEdge.rawWeight; // El rawWeight se invierte para el borde inverso
                    reverseEdge.metadata = newEdge.metadata;
                }
            }
        } else {
            // Si el borde no existe, añadirlo
            this.addEdge(newEdge);
        }

        return this;
    }
}