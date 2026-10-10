export const KEYSYMS: Record<string, number>;
export const PINCH_IN: number;
export const PINCH_OUT: number;
export interface ControlState { zoom: 'fit' | '100'; pan: boolean; mods: Record<string, boolean> }
export interface Controls { setZoom(mode: 'fit' | '100'): void; setPan(on: boolean): void; toggleMod(name: 'ctrl' | 'alt' | 'shift'): void; press(key: string | number): boolean; type(text: string): void; releaseAll(): void; detach(): void; readonly state: ControlState }
export function attachControls(host: HTMLElement, getRfb: () => any, opts?: { onChange?: (s: ControlState) => void }): Controls;
