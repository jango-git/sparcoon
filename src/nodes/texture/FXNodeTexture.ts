import { FXNode } from "../FXNode";

/**
 * Abstract base class for particle texture nodes
 */
export abstract class FXNodeTexture extends FXNode {
  /** @internal */
  public abstract readonly colorExpression: string;
}
