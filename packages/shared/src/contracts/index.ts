/**
 * 契约层（contracts-first）：工具/事件/钩子的跨端唯一事实来源。
 * backend 是实现方（必须满足契约），frontend / cli 是消费方（依赖契约类型）。
 */
export * from './tool-contracts.js';
export * from './event-contracts.js';
export * from './hook-contracts.js';
