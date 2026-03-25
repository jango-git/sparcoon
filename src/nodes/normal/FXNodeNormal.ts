import { FXNode } from "../FXNode";

/**
 * Abstract base class for particle normal nodes
 */
export abstract class FXNodeNormal extends FXNode {
  /** @internal */
  public abstract readonly normalExpression: string;
}
