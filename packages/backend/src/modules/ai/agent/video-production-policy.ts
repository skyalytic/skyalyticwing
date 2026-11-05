export const VIDEO_PRODUCTION_PROMPT = `视频制作有两条独立路径：
1. 代码制作：使用 file-write 编写纯 JavaScript 绘图函数，再调用 render_code_video，把字幕、歌词、图表、教学演示、程序动画渲染为 MP4。可以使用已有音轨或嵌入已有图片；长片可分场景制作后 concat_videos。没有视频模型也能完成这类视频，不得笼统声称无法制作。脚本和成片保存在工作区；成功的工具文件会自动进入聊天预览，不要重复调用发送文件工具。
2. 视频模型生成：generate_video 会提交供应商生成任务，可能产生费用。用户明确不要视频模型、只用代码或本地制作时，必须选择代码路径，不能通过终端、HTTP 或其他工具绕过这个要求。代码制作失败时修复代码，不能擅自改为付费生成。
先理解画面需求再选路径：文字准确性、图表、UI 演示、程序动画优先代码；需要真实人物/自然场景时检查现有素材或视频模型能力。用户要求的效果无法通过代码和现有素材实现时，明确说明并询问是否接受替代方案，不能把简单动画冒充原要求。
提示词太长或视频模型不满足要求时，可整理完整需求为分镜与时间轴，评估代码制作；不要静默丢弃内容或改变效果。供应商提交结果未知时先核实原任务，不能另起付费任务造成重复扣费。时长不是代码视频的固定上限，按需要逐帧渲染或分段拼接；执行过程中用户停止必须停止。只有拿到可用视频文件才可宣称完成，不能把代码文件或 HTML 动画当作已导出的 MP4。`;

/** Conservative recognition of explicit user instructions, never model/tool output. */
export function updateVideoCodeOnly(previous: boolean, text: string): boolean {
  const forbid=/(?:不要|不用|禁止|不允许|不使用|别(?:再)?)(?:使用|调用|通过|用)?\s*视频(?:生成)?(?:大)?模型|(?:只|仅)(?:能)?(?:使用|用)?(?:代码|本地)(?:来)?(?:制作|生成|做).{0,6}视频|(?:do not|don't|without|never use|no)\s+(?:use\s+)?(?:any\s+)?video[ -]?(?:generation[ -]?)?(?:models?|apis?)/gi;
  const permit=/(?:现在允许|这次允许|改为使用|改用)\s*视频(?:生成)?(?:大)?模型|(?:now allow|switch to)\s+(?:a\s+)?video[ -]?(?:generation[ -]?)?model/gi;
  let result=previous,last=-1;
  for(const [pattern,value] of [[forbid,true],[permit,false]] as const)
    for(const match of text.matchAll(pattern))if(match.index>=last){last=match.index;result=value}
  return result;
}

export const CODE_VIDEO_REQUIRED='用户已要求不用视频模型；请编写绘图函数并使用 render_code_video，不能提交视频模型任务。';
