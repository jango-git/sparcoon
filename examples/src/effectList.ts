import type { Example } from "./catalog";

/** The list of effects. Each row links to its hash, and the open one is marked. */
export class EffectList {
  private readonly rows = new Map<string, HTMLLIElement>();

  public constructor(list: HTMLUListElement, examples: readonly Example[]) {
    for (const example of examples) {
      const link = document.createElement("a");
      link.href = `#${example.id}`;
      link.append(span("marker"), span("name", example.title), span("tags", example.tags));
      const row = document.createElement("li");
      row.append(link);
      list.append(row);
      this.rows.set(example.id, row);
    }
  }

  public mark(id: string): void {
    for (const [rowId, row] of this.rows) {
      row.classList.toggle("active", rowId === id);
    }
    this.rows.get(id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function span(className: string, text = ""): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}
