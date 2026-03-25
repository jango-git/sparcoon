import { FXNode } from "../FXNode";

/**
 * Abstract base class for particle color nodes
 */
export abstract class FXNodeBlending extends FXNode {
  /** @internal */
  public abstract readonly blendingExpression: string;
}
