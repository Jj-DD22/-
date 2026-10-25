// Capability routing uses model observations, never dataset labels or confidence alone.
export const ASSESSMENT_ENUMS={
  material:['opaque','translucent','transparent','unknown'],
  holes:['none','present','unknown'],
  productOcclusion:['none','minor','essential','unknown'],
  angle:['compatible','moderate','incompatible','unknown'],
  sourceView:['rear','rearOblique','profile','front','unknown'],
  productView:['rear','rearOblique','profile','front','unknown'],
  target:['single','multiple','unknown'],
  attachment:['planar','wraparound','curved','unknown']
};
export function validateAssessment(value){
  if(value==null)return null;
  if(typeof value!=='object'||Array.isArray(value))throw Error('素材判断格式无效。');
  const result={};
  for(const [key,allowed] of Object.entries(ASSESSMENT_ENUMS)){
    // Old assessment schemas remain readable, but absent view evidence is unknown.
    const observed=['sourceView','productView'].includes(key)&&value[key]===undefined?'unknown':value[key];
    if(!allowed.includes(observed))throw Error('素材判断字段无效。');
    result[key]=observed;
  }
  return result;
}
const reasons={
  unknown:{message:'素材信息不足，暂不能确认商品结构和佩戴条件。',nextAction:'请换用商品主体完整、轮廓清晰、与人物图角度接近的参考图后重新分析。'},
  transparency:{message:'检测到透明或半透明材质，当前流程无法可靠分离原照片背景。',nextAction:'请转人工确认透明材质；补图时提供带真实透明通道的独立商品图，补图后仍需确认。'},
  holes:{message:'检测到内部孔洞，当前外轮廓抠图会携带原照片的头发。',nextAction:'请转人工确认孔洞抠图；补图时提供孔洞已透明的独立商品 PNG，补图后仍需确认。'},
  occlusion:{message:'参考商品的重要结构被遮挡，无法保证商品形状和细节。',nextAction:'请补充商品主体完整、没有手指或头发遮挡的参考图。'},
  angle:{message:'人物图与商品图存在无法通过平面旋转解决的角度差异。',nextAction:'请补充与人物佩戴方向接近的商品参考图，或转人工确认透视与遮挡。'},
  viewUnknown:{message:'无法确认人物图或商品参考图的佩戴视角，已停止自动处理。',nextAction:'请补充能清晰判断头部朝向、耳部或面部位置的佩戴图，并提供与人物图相同视角的完整商品参考图后重新分析。'},
  viewMismatch:{message:'人物佩戴视角与商品参考视角不同，当前平面摆放无法可靠转换视角。',nextAction:'请提供与人物图相同视角的完整商品佩戴参考图；正后方、后侧、正侧或正面需要一致，再重新分析。'},
  target:{message:'图片包含多个候选商品，无法可靠确定要替换哪一件。',nextAction:'请裁剪到目标商品或明确点选要替换的发饰。'},
  attachment:{message:'该发饰需要环绕或贴合头部曲面，平面摆放无法保证真实佩戴关系。',nextAction:'请提供佩戴位置和角度接近的参考图，并人工确认前后遮挡。'},
  confidence:{message:'模型对轮廓或佩戴位置不确定。',nextAction:'请检查目标商品，换用更清晰的图片或人工确认位置。'}
};
export function assessSupport(plan){
  const a=plan.assessment,codes=[];let adaptations=[];
  const rotation=plan.placement?.rotationDegrees??0;
  const views=new Set([a?.sourceView,a?.productView]);
  const rearPair=views.size===2&&views.has('rear')&&views.has('rearOblique');
  const planarRotationSupported=!!a&&rearPair&&a.angle==='moderate'&&a.material==='opaque'&&a.holes==='none'&&
    ['none','minor'].includes(a.productOcclusion)&&a.target==='single'&&a.attachment==='planar'&&
    typeof rotation==='number'&&Number.isFinite(rotation)&&plan.placement?.rotationSpecified===true&&Math.abs(rotation)<=30&&plan.confidence>=.7;
  const moderateRotationSupported=!!a&&a.angle==='moderate'&&a.material==='opaque'&&a.holes==='none'&&
    ['none','minor'].includes(a.productOcclusion)&&a.target==='single'&&a.attachment==='planar'&&
    typeof rotation==='number'&&Number.isFinite(rotation)&&plan.placement?.rotationSpecified===true&&Math.abs(rotation)<=30&&plan.confidence>=.7;
  if(planarRotationSupported||moderateRotationSupported)adaptations=['planarRotation'];
  if(!a||Object.values(a).includes('unknown'))codes.push('unknown');
  if(!a||![a.sourceView,a.productView].every(view=>ASSESSMENT_ENUMS.sourceView.includes(view)&&view!=='unknown'))codes.push('viewUnknown');
  else if(a.sourceView!==a.productView&&!planarRotationSupported)codes.push('viewMismatch');
  if(a){
    if(['translucent','transparent'].includes(a.material))codes.push('transparency');
    if(a.holes==='present')codes.push('holes');
    if(a.productOcclusion==='essential')codes.push('occlusion');
    if(a.angle!=='compatible'&&a.angle!=='unknown'&&!moderateRotationSupported)codes.push('angle');
    if(a.target==='multiple')codes.push('target');
    if(['wraparound','curved'].includes(a.attachment))codes.push('attachment');
  }
  if(plan.confidence<.7)codes.push('confidence');
  return {policyVersion:'hair-capability-v3-planar-rotation',route:codes.length?'needsReview':'autoCandidate',reasonCodes:codes,adaptations,
    reasons:codes.map(code=>({code,...reasons[code]})),assessment:a||null};
}
