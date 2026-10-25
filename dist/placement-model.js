// Coordinates are always source-image pixels, independent of canvas zoom.
export const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
export function fitPlacement(source,product,region){
  const r=region||{x:source.width*.3,y:source.height*.3,width:source.width*.4,height:source.height*.4};
  const height=Math.min(r.height*.88,r.width*.88*product.height/product.width,source.height);
  const width=height*product.width/product.height;
  return {x:r.x+(r.width-width)/2,y:r.y+r.height-height,width,height};
}
export function movePlacement(p,dx,dy,source){return {...p,x:clamp(p.x+dx,0,source.width-p.width),y:clamp(p.y+dy,0,source.height-p.height)};}
export function scalePlacement(p,height,source){
  const ratio=p.width/p.height,cx=p.x+p.width/2,bottom=p.y+p.height;
  height=clamp(height,Math.min(8,source.height,source.width/ratio),Math.min(source.height,source.width/ratio));
  const width=height*ratio;
  return {x:clamp(cx-width/2,0,source.width-width),y:clamp(bottom-height,0,source.height-height),width,height};
}
export function resizePlacement(p,corner,dx,dy,source){
  const sx=corner.includes('e')?1:-1,sy=corner.includes('s')?1:-1;
  const ax=sx===1?p.x:p.x+p.width,ay=sy===1?p.y:p.y+p.height;
  const ratio=p.width/p.height;
  // Projection onto the aspect-ratio diagonal prevents horizontal stretching.
  const delta=(sx*dx*ratio+sy*dy)/(ratio*ratio+1);
  const maxHeight=Math.min(sy===1?source.height-ay:ay,(sx===1?source.width-ax:ax)/ratio);
  const height=clamp(p.height+delta,Math.min(8,maxHeight),maxHeight),width=height*ratio;
  return {x:sx===1?ax:ax-width,y:sy===1?ay:ay-height,width,height};
}
export function validPlacement(p,source,product){
  return !!p&&['x','y','width','height'].every(k=>Number.isFinite(p[k]))&&p.x>=0&&p.y>=0&&p.width>=1&&p.height>=1&&p.x+p.width<=source.width+.001&&p.y+p.height<=source.height+.001&&Math.abs(p.width/p.height-product.width/product.height)<.001;
}
