import { create } from 'zustand';

export interface AskUserRequest {
  id: string;
  sessionId?: string;
  question: string;
  options: string[];
  multiple: boolean;
}
export interface AskUserState {
  requests: AskUserRequest[];
  show: (request: AskUserRequest) => void;
  remove: (id: string) => void;
  sync: (requests: AskUserRequest[]) => void;
}
export const useAskUserStore = create<AskUserState>()(set => ({
  requests: [],
  show: request => set(state => ({ requests: state.requests.some(r => r.id === request.id)
    ? state.requests : [...state.requests, request] })),
  remove: id => set(state => ({ requests: state.requests.filter(r => r.id !== id) })),
  sync: requests => set({ requests }),
}));
