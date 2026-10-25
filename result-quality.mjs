// Process completion and pixel preservation do not establish visual acceptance.
export function assessResultQuality(verification,options={}){
  const checks={},reasonCodes=[];
  const integer=value=>Number.isSafeInteger(value)&&value>=0;
  function exact(name,value){
    checks[name]=integer(value)?value===0:null;
    if(checks[name]!==true)reasonCodes.push(checks[name]===false?'PROTECTION_CHANGED':'VERIFICATION_INCOMPLETE');
  }
  const v=verification||{};
  const supplied=names=>names.some(name=>Object.hasOwn(v,name));
  checks.dimensions=Array.isArray(v.dimensions)&&v.dimensions.length===2&&v.dimensions.every(value=>Number.isSafeInteger(value)&&value>0);
  if(!checks.dimensions)reasonCodes.push('VERIFICATION_INCOMPLETE');
  exact('outsidePermission',v.maxChangeOutsideMask);
  const productEvidence=options.preserveProduct||supplied(['productProtectedPixels','productMaxPixelDifference']);
  const foregroundEvidence=options.preserveProduct||supplied(['foregroundProtectedPixels','foregroundMaxPixelDifference']);
  if(productEvidence){
    if(!integer(v.productProtectedPixels)||v.productProtectedPixels===0){checks.productCore=null;reasonCodes.push('VERIFICATION_INCOMPLETE');}
    else exact('productCore',v.productMaxPixelDifference);
  }
  if(foregroundEvidence){
    if(!integer(v.foregroundProtectedPixels)){checks.foregroundCore=null;reasonCodes.push('VERIFICATION_INCOMPLETE');}
    else if(v.foregroundProtectedPixels===0){
      checks.foregroundCore='notApplicable';
      if(v.foregroundMaxPixelDifference!==null){checks.foregroundCore=null;reasonCodes.push('VERIFICATION_INCOMPLETE');}
    }else exact('foregroundCore',v.foregroundMaxPixelDifference);
  }
  if(options.backgroundOnlyGeneration||supplied(['maxBackgroundChangeOutsideOldObject']))exact('backgroundOutsideOldObject',v.maxBackgroundChangeOutsideOldObject);
  for(const [name,key] of [['outsideRefinement','maxChangeOutsideRefinement'],['productFromPrevious','productChangeFromPrevious'],['foregroundFromPrevious','foregroundChangeFromPrevious']])if(supplied([key]))exact(name,v[key]);
  const hardPassed=Object.values(checks).every(value=>value===true||value==='notApplicable');
  return {schemaVersion:1,status:hardPassed?'needsReview':'failed',accepted:false,hardChecks:{passed:hardPassed,checks},visualAcceptance:'pending',reasonCodes:[...new Set(reasonCodes.length?reasonCodes:['VISUAL_REVIEW_REQUIRED'])],summary:hardPassed?'像素保护检查通过，图片仍需确认商品轮廓、旧物残留和佩戴关系。':'结果未通过像素保护检查，已停止交付。',nextActions:hardPassed?['请放大检查商品边缘是否带入来源头发、旧发饰是否清除，以及佩戴位置是否合理。']:['请重新分析素材后重试；若仍失败，请联系主机管理员检查区域保护记录。']};
}
