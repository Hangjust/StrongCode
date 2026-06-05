export type TuiLayerKind = "palette" | "dialog" | "toast";

export interface TuiLayer {
  id: string;
  kind: TuiLayerKind;
  title: string;
  body: string[];
}

export class TuiLayerStack {
  private layers: TuiLayer[] = [];

  push(layer: TuiLayer): void {
    this.layers = [...this.layers.filter(existing => existing.id !== layer.id), layer];
  }

  remove(id: string): void {
    this.layers = this.layers.filter(layer => layer.id !== id);
  }

  clear(kind?: TuiLayerKind): void {
    this.layers = kind ? this.layers.filter(layer => layer.kind !== kind) : [];
  }

  top(kind?: TuiLayerKind): TuiLayer | undefined {
    const matching = kind ? this.layers.filter(layer => layer.kind === kind) : this.layers;
    return matching[matching.length - 1];
  }

  all(): TuiLayer[] {
    return [...this.layers];
  }
}
