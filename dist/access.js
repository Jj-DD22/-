const form=document.getElementById('accessForm'),button=document.getElementById('enterStudio'),error=document.getElementById('accessError');
form.addEventListener('submit',async event=>{
  event.preventDefault();button.disabled=true;error.hidden=true;
  try{const response=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:document.getElementById('accessCode').value.trim()})});const data=await response.json();if(!response.ok)throw new Error(data.error);location.replace('/');}
  catch(reason){error.textContent=reason.message||'暂时无法连接主机，请稍后再试。';error.hidden=false;button.disabled=false;}
});
