export interface ChannelConfig {
  name: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}
