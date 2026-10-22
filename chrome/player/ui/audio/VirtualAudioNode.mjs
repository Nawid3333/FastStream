// @ts-check

/**
 * A node of the audio graph: a Web Audio node, or a virtual one that stands for the nodes
 * connected to it.
 * @typedef {AudioNode|VirtualAudioNode} GraphNode
 */

/**
 * A connection of a virtual node: the node at its other end, and the output and input
 * index it was made with (undefined where connect() was given none).
 * @typedef {[GraphNode, number|undefined, number|undefined]} Connection
 */

/**
 * A Web Audio node a virtual one stands for, with the index of its output (or input) the
 * connection uses.
 * @typedef {[AudioNode, number|undefined]} RealEnd
 */

export class VirtualAudioNode {
  /**
   * @param {string} name - For debugging.
   */
  constructor(name) {
    this.name = name;
    /** @type {Connection[]} */
    this.inputNodes = [];
    /** @type {Connection[]} */
    this.outputNodes = [];
  }

  /**
   * @param {GraphNode} node
   * @return {node is VirtualAudioNode}
   */
  static isVirtualAudioNode(node) {
    return node instanceof VirtualAudioNode;
  }

  /**
   * The Web Audio nodes whose output reaches this node.
   * @param {GraphNode} node
   * @param {number} [outputIndex]
   * @return {RealEnd[]}
   */
  static getRealInputNodes(node, outputIndex) {
    if (!VirtualAudioNode.isVirtualAudioNode(node)) {
      return [[node, outputIndex]];
    } else {
      /** @type {RealEnd[]} */
      const realInputNodes = [];
      node.inputNodes.forEach(([inputNode, nextOutputIndex, nextInputIndex]) => {
        if (outputIndex !== undefined && nextInputIndex !== undefined && outputIndex !== nextInputIndex) {
          return;
        }
        realInputNodes.push(...VirtualAudioNode.getRealInputNodes(inputNode, nextOutputIndex));
      });
      return realInputNodes;
    }
  }

  /**
   * The Web Audio nodes this node's output reaches.
   * @param {GraphNode} node
   * @param {number} [inputIndex]
   * @return {RealEnd[]}
   */
  static getRealOutputNodes(node, inputIndex) {
    if (!VirtualAudioNode.isVirtualAudioNode(node)) {
      return [[node, inputIndex]];
    } else {
      /** @type {RealEnd[]} */
      const realOutputNodes = [];
      node.outputNodes.forEach(([outputNode, nextOutputIndex, nextInputIndex]) => {
        if (inputIndex !== undefined && nextOutputIndex !== undefined && inputIndex !== nextOutputIndex) {
          return;
        }
        realOutputNodes.push(...VirtualAudioNode.getRealOutputNodes(outputNode, nextInputIndex));
      });
      return realOutputNodes;
    }
  }

  /**
   * @param {RealEnd[]} inputNodes
   * @param {RealEnd[]} outputNodes
   */
  static connectOverlap(inputNodes, outputNodes) {
    inputNodes.forEach(([inputNode, outputIndex]) => {
      outputNodes.forEach(([outputNode, inputIndex]) => {
        try {
          inputNode.connect(outputNode, outputIndex, inputIndex);
        } catch (e) {
          console.error(e);
        }
      });
    });
  }

  /**
   * @param {RealEnd[]} inputNodes
   * @param {RealEnd[]} outputNodes
   */
  static disconnectOverlap(inputNodes, outputNodes) {
    inputNodes.forEach(([inputNode, outputIndex]) => {
      outputNodes.forEach(([outputNode, inputIndex]) => {
        try {
          // An index left undefined is read as 0 here (WebIDL), the default connect() used.
          inputNode.disconnect(outputNode, /** @type {number} */ (outputIndex), /** @type {number} */ (inputIndex));
        } catch (e) {
          console.error(e);
        }
      });
    });
  }

  /**
   * @param {GraphNode} otherNode
   * @param {number} [outputIndex]
   * @param {number} [inputIndex]
   * @return {number} The connection's place in inputNodes, or -1.
   */
  indexConnectedFrom(otherNode, outputIndex, inputIndex) {
    return this.inputNodes.findIndex(([node, outputIndex2, inputIndex2]) => node === otherNode && outputIndex2 === outputIndex && inputIndex2 === inputIndex);
  }

  /**
   * @param {GraphNode} otherNode
   * @param {number} [outputIndex]
   * @param {number} [inputIndex]
   * @return {number} The connection's place in outputNodes, or -1.
   */
  indexConnectedTo(otherNode, outputIndex, inputIndex) {
    return this.outputNodes.findIndex(([node, outputIndex2, inputIndex2]) => node === otherNode && outputIndex2 === outputIndex && inputIndex2 === inputIndex);
  }

  /**
   * @param {GraphNode} otherNode
   * @param {number} [outputIndex]
   * @param {number} [inputIndex]
   */
  connect(otherNode, outputIndex, inputIndex) {
    if (this.indexConnectedTo(otherNode, outputIndex, inputIndex) !== -1) {
      return;
    }

    this.outputNodes.push([otherNode, outputIndex, inputIndex]);
    if (VirtualAudioNode.isVirtualAudioNode(otherNode)) {
      otherNode.inputNodes.push([this, outputIndex, inputIndex]);
    }

    const inputNodes = VirtualAudioNode.getRealInputNodes(this, outputIndex);
    const outputNodes = VirtualAudioNode.getRealOutputNodes(otherNode, inputIndex);
    VirtualAudioNode.connectOverlap(inputNodes, outputNodes);
  }

  /**
   * @param {GraphNode} otherNode
   * @param {number} [outputIndex]
   * @param {number} [inputIndex]
   */
  connectFrom(otherNode, outputIndex, inputIndex) {
    if (this.indexConnectedFrom(otherNode, outputIndex, inputIndex) !== -1) {
      return;
    }

    this.inputNodes.push([otherNode, outputIndex, inputIndex]);
    if (VirtualAudioNode.isVirtualAudioNode(otherNode)) {
      otherNode.outputNodes.push([this, outputIndex, inputIndex]);
    }

    const inputNodes = VirtualAudioNode.getRealInputNodes(otherNode, outputIndex);
    const outputNodes = VirtualAudioNode.getRealOutputNodes(this, inputIndex);
    VirtualAudioNode.connectOverlap(inputNodes, outputNodes);
  }

  /**
   * @param {GraphNode} otherNode
   * @param {number} [outputIndex]
   * @param {number} [inputIndex]
   */
  disconnect(otherNode, outputIndex, inputIndex) {
    const index = this.indexConnectedTo(otherNode, outputIndex, inputIndex);
    if (index === -1) {
      throw new Error('Node not connected');
    }

    this.outputNodes.splice(index, 1);
    if (VirtualAudioNode.isVirtualAudioNode(otherNode)) {
      const inputInd = otherNode.indexConnectedFrom(this, outputIndex, inputIndex);
      if (inputInd === -1) {
        throw new Error('Node not connected');
      }
      otherNode.inputNodes.splice(inputInd, 1);
    }

    const inputNodes = VirtualAudioNode.getRealInputNodes(this, outputIndex);
    const outputNodes = VirtualAudioNode.getRealOutputNodes(otherNode, inputIndex);
    VirtualAudioNode.disconnectOverlap(inputNodes, outputNodes);
  }

  /**
   * @param {GraphNode} otherNode
   * @param {number} [outputIndex]
   * @param {number} [inputIndex]
   */
  disconnectFrom(otherNode, outputIndex, inputIndex) {
    const index = this.indexConnectedFrom(otherNode, outputIndex, inputIndex);
    if (index === -1) {
      throw new Error('Node not connected');
    }

    this.inputNodes.splice(index, 1);
    if (VirtualAudioNode.isVirtualAudioNode(otherNode)) {
      const outputInd = otherNode.indexConnectedTo(this, outputIndex, inputIndex);
      if (outputInd === -1) {
        throw new Error('Node not connected');
      }
      otherNode.outputNodes.splice(outputInd, 1);
    }

    const inputNodes = VirtualAudioNode.getRealInputNodes(otherNode, outputIndex);
    const outputNodes = VirtualAudioNode.getRealOutputNodes(this, inputIndex);
    VirtualAudioNode.disconnectOverlap(inputNodes, outputNodes);
  }
}
