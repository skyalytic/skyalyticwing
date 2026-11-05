import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { DesktopControlService, type DesktopRequest } from '../../../modules/automation/desktop-control.service.js';
import type { ServiceResolver } from '../../../modules/tools/executor/built-in/service-resolver.js';
import { archiveDesktopObservation } from './runtime/desktop-observation-archive.js';
export function createComputerUseTool(resolve: ServiceResolver): ToolDefinition {
  /** Screen pixels and the selected input transport; UIA is not part of the model's desktop workflow. */
  return {
    name: 'computer_use',
    description: 'Operate the desktop using screenshots and real OS mouse/keyboard input on Windows, macOS and Linux X11. No virtual mouse mode is available. For a named app, first list_windows to distinguish its main process and visible/hidden state; then screenshot (no root needed). Hidden main windows must be restored from the observed tray, not confused with a visible mini-app of the same title. Open or restore apps by clicking their visible icons, including the tray overflow; do not launch them with terminal commands. Act with the latest screenshotId and coordinates in that returned image. Every act returns the next screenshot: inspect it and continue directly. click/moveMouse/scroll/drag use targetX/targetY; typeText uses params.text; keypress uses params.key. For small icons use zoom with screenshotId and region:{x,y,width,height}; it returns a magnified pixel crop. Use regions.notificationArea when available to zoom the entire system tray. No UIA tree required. Verify focus before typing, the exact recipient before sending, and the sent bubble afterwards. A delivered input is not task completion. If nothing changed, reassess the screenshot instead of repeating the same click. The user can stop at any time. Wayland requires a Portal adapter and is currently unsupported.',
    category: 'automation',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'pause', 'screenshot', 'zoom', 'look', 'act', 'act_batch', 'wait_for', 'list_windows', 'focus_window'] },
        steps: { type: 'array', minItems: 1, description: 'act_batch: a short ordered sequence on the observed interface, e.g. click a known search field then type. All pointer coordinates refer to the initial screenshotId. Stops on failure, window/foreground change or user interruption; inspect completed/stoppedAt and the returned screenshot, never replay the whole batch. Observe search results and confirm the recipient before a separate send.', items: { type: 'object', properties: { kind: { type: 'string', enum: ['click', 'moveMouse', 'drag', 'scroll', 'typeText', 'keypress'] }, targetX: { type: 'number' }, targetY: { type: 'number' }, params: { type: 'object', additionalProperties: true } }, required: ['kind'], additionalProperties: false } },
        condition: { type: 'string', enum: ['changed', 'stable'], description: 'wait_for: poll the image for visual change or stability. Optional region uses latest screenshotId coordinates. This does NOT recognize text or prove task success; inspect the returned image.' },
        region: { type: 'object', properties: { x: {type:'number'}, y: {type:'number'}, width: {type:'number'}, height: {type:'number'} }, required: ['x','y','width','height'], additionalProperties: false, description: 'zoom: crop a region in the latest image to inspect small tray icons or text. It returns a new image; use coordinates within that new image.' },
        screenshotId: { type: 'string', description: 'Latest returned screenshot ID; required for act.' },
        rootRef: { type: 'string', description: 'Optional returned window root. Omit for a full desktop screenshot including tray and menus.' },
        windowId: { type: 'number', description: 'Optional window ID returned by list_windows.' },
        kind: { type: 'string', enum: ['click', 'moveMouse', 'drag', 'scroll', 'typeText', 'keypress'] },
        targetX: { type: 'number', description: 'X pixel in the returned image. Do not convert DPI or add window origin.' },
        targetY: { type: 'number', description: 'Y pixel in the returned image.' },
        params: { type: 'object', description: 'typeText:{text}; keypress:{key:"Ctrl+A"}; click:{button:"left",clickCount:1}; scroll:{deltaY:-120} down, positive up; drag:{toX,toY,durationMs}.', additionalProperties: true },
        timeoutMs: { type: 'number', description: 'wait_for timeout in milliseconds: visual condition defaults to 3000; simple delay defaults to 500.' },
        text: { type: 'string', description: 'Optional condition to inspect visually after wait_for.' },
      },
      required: ['action'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as DesktopRequest;
      if (!a || typeof a.action !== 'string') return { success: false, error: 'action required' };
      const control = resolve(DesktopControlService);
      if (!control) return { success: false, error: 'Desktop control service unavailable' };
      return archiveDesktopObservation(await control.execute(ctx.sessionId, { ...a, mode: 'visual' }), ctx.sessionId);
    },
  };

}
