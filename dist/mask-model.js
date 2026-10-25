export const clamp=(n,min=0,max=1)=>Math.max(min,Math.min(max,n));
export function normalizedPoint(x,y,rect){
  if(!(rect.width>0&&rect.height>0))throw new Error('Canvas has no visible area');
  return {x:clamp((x-rect.left)/rect.width),y:clamp((y-rect.top)/rect.height)};
}
export function selectionRect(a,b){
  const x=clamp(Math.min(a.x,b.x)),y=clamp(Math.min(a.y,b.y));
  return {x,y,width:clamp(Math.max(a.x,b.x))-x,height:clamp(Math.max(a.y,b.y))-y};
}
export function pixelCrop(a,b,width,height){
  const r=selectionRect(a,b),x=Math.floor(r.x*width),y=Math.floor(r.y*height);
  return {x,y,width:Math.min(width-x,Math.ceil((r.x+r.width)*width)-x),height:Math.min(height-y,Math.ceil((r.y+r.height)*height)-y)};
}
export class MaskHistory{
  constructor(operations=[],index=operations.length){this.operations=structuredClone(operations);this.index=clamp(index,0,operations.length);}
  get active(){return this.operations.slice(0,this.index);}
  get canUndo(){return this.index>0;}
  get canRedo(){return this.index<this.operations.length;}
  commit(operation){this.operations.splice(this.index);this.operations.push(structuredClone(operation));this.index=this.operations.length;}
  undo(){if(this.canUndo)this.index--;}
  redo(){if(this.canRedo)this.index++;}
  serialize(){return {operations:this.operations,index:this.index};}
}
