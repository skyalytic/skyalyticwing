// 连接状态 store
import { create } from 'zustand';
import type { ConnectionStatus } from '@/types';

export interface ConnectionState {
  status: ConnectionStatus;
  reconnectAttempts: number;
  lastConnectedAt: number | null;
  setStatus: (status: ConnectionStatus) => void;
  setReconnectAttempts: (attempts: number) => void;
  markConnected: () => void;
}

export const useConnectionStore = create<ConnectionState>()((set) => ({
  status: 'disconnected',
  reconnectAttempts: 0,
  lastConnectedAt: null,

  setStatus: (status) => set({ status }),

  setReconnectAttempts: (attempts) => set({ reconnectAttempts: attempts }),

  markConnected: () =>
    set({ status: 'connected', reconnectAttempts: 0, lastConnectedAt: Date.now() }),
}));
