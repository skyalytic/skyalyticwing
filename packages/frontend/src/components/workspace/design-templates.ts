export type DesignTemplate = 'blank' | 'poster' | 'card';
export function newDesignHtml(template: DesignTemplate): string {
  const elements =
    template === 'poster'
      ? '<div data-wing-element data-wing-name="色块" style="position:absolute;left:760px;top:0;width:520px;height:800px;background:#b9e8dd"></div><h1 data-wing-element data-wing-name="标题" style="position:absolute;left:80px;top:170px;width:650px;font-size:76px;line-height:1.15;margin:0;color:#163c38">把想法<br>变成设计</h1><p data-wing-element data-wing-name="副标题" style="position:absolute;left:85px;top:400px;font-size:26px;color:#536863">双击修改文字，拖动元素调整布局</p>'
      : template === 'card'
        ? '<div data-wing-element data-wing-name="卡片" style="position:absolute;left:220px;top:180px;width:840px;height:440px;background:#eef4ff;border-radius:32px"></div><h1 data-wing-element data-wing-name="标题" style="position:absolute;left:280px;top:260px;font-size:52px;margin:0;color:#203e70">你的品牌名称</h1><p data-wing-element data-wing-name="介绍" style="position:absolute;left:280px;top:360px;font-size:24px;color:#5b6e8f">在这里写下产品介绍</p>'
        : '';
  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>设计稿</title><style>html{min-height:100%;background:white}body{margin:0;position:relative;min-height:100vh;font-family:Arial,"Microsoft YaHei",sans-serif}*{box-sizing:border-box}</style></head><body>' +
    elements +
    '</body></html>'
  );
}
