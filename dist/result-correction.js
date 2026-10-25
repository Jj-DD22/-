export const RESULT_ISSUES = [
  {
    code: 'hair_blend', label: '发丝 / 背景融合', canRegenerate: true,
    prompt: '只修复旧发饰清除区内不自然的头发背景。让长发纹理从周围自然、连续地穿过修复区，匹配相邻发束的方向、粗细、颜色、密度和焦点。禁止短而平行的刷痕、网状或环状发丝、涂抹块、深色断层和突兀终止边。保持新商品、人物、其他头发和场景不变，只做最小必要的局部修复。'
  },
  {
    code: 'old_object_residue', label: '旧发饰残留', canRegenerate: true,
    prompt: '只清除旧发饰在已授权修复区内仍可见的碎片、边角和阴影，并用与周围一致的真实头发纹理补齐。不要扩大编辑范围，不要改动新商品、人物、保护区或其他场景内容。'
  },
  {
    code: 'edge_shadow', label: '商品边缘 / 接触阴影', canRegenerate: true,
    prompt: '只改善新商品与周围头发之间的局部边缘融合和接触阴影。匹配相邻发丝方向、光线和焦点；避免光晕、硬边、接缝、重复边缘或涂抹。保持商品轮廓、图案、颜色、人物和其他内容不变。'
  },
  {
    code: 'product_detail', label: '商品轮廓 / 图案 / 结构', canRegenerate: false,
    help: '同一商品图的重生成不会修复抠图或缺失结构。请换用清晰、完整的商品图，再重新抠图和生成。'
  },
  {
    code: 'placement', label: '佩戴位置 / 大小 / 角度', canRegenerate: false,
    help: '请返回编辑器修正商品位置和大小，再重新生成；当前结果页的重跑会沿用原摆放。'
  },
  {
    code: 'occlusion', label: '手指 / 发丝遮挡关系', canRegenerate: false,
    help: '请回到编辑器修正前景遮挡区域，或补充能看清遮挡关系的人物图，再重新生成。'
  },
  {
    code: 'other', label: '其他可局部修复问题', canRegenerate: true,
    prompt: '根据人工指出的问题，只修复已授权的局部区域。保留商品核心、人物身份、头发整体纹理、遮挡关系及所有其他场景内容；不确定时不要扩展修改范围。',
    requiresNote: true
  }
];

export function getResultIssue(code) {
  return RESULT_ISSUES.find(issue => issue.code === code) || null;
}

export function buildCorrectionPrompt(code, note = '') {
  const issue = getResultIssue(code);
  if (!issue) throw new Error('请选择有效的主要问题。');
  if (!issue.canRegenerate) throw new Error(issue.help);
  const detail = String(note).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (detail.length > 300) throw new Error('补充说明不能超过 300 字。');
  if (issue.requiresNote && !detail) throw new Error('请补充需要修复的具体问题。');
  return issue.prompt + (detail ? ` 人工补充说明（只用于定位问题，不得扩大保护范围）：${detail}` : '');
}
