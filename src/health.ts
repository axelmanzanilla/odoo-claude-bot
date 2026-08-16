export type ComponentName = 'configuration' | 'database' | 'claude' | 'mcp' | 'discord';
export type ComponentStatus = 'ready' | 'unhealthy' | 'starting' | 'stopped' | 'disabled';

export class ReadinessState {
  private readonly components = new Map<ComponentName, ComponentStatus>([
    ['configuration', 'starting'],
    ['database', 'starting'],
    ['claude', 'starting'],
    ['mcp', 'starting'],
    ['discord', 'starting'],
  ]);

  set(component: ComponentName, status: ComponentStatus): void {
    this.components.set(component, status);
  }

  isReady(): boolean {
    return [...this.components.values()].every(
      (status) => status === 'ready' || status === 'disabled',
    );
  }

  summary(): string {
    return [...this.components.entries()].map(([name, status]) => `${name}: ${status}`).join(', ');
  }
}
