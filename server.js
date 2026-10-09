// Attendify - حاضر | بدون أي مكتبات: node server.js
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=process.env.PORT||3000, PASS=process.env.DOCTOR_PASSWORD||'1234';
const SECRET=crypto.randomBytes(16).toString('hex');
const SLOT=30000, MAX_ABSENCE=25, MAX_ACC=150, DB=process.env.DB_FILE||'data.json';
const students=JSON.parse(fs.readFileSync(path.join(__dirname,'students.json'),'utf8'));
const byId=Object.fromEntries(students.map(s=>[s.id,s]));
let db={lectures:[],att:[],devices:{}};
try{db=JSON.parse(fs.readFileSync(DB,'utf8'))}catch{}
const save=()=>{fs.writeFileSync(DB+'.tmp',JSON.stringify(db));fs.renameSync(DB+'.tmp',DB)};
const sig=(l,s)=>crypto.createHmac('sha256',SECRET).update(l+'.'+s).digest('hex').slice(0,16);
const slot=()=>Math.floor(Date.now()/SLOT);
const mkToken=l=>{const s=slot();return l+'.'+s+'.'+sig(l,s)};
const valid=t=>{const [l,s,g]=String(t).split('.');if(!g||g.length!==16)return false;
  const ok=crypto.timingSafeEqual(Buffer.from(g),Buffer.from(sig(l,s)));return ok&&slot()-Number(s)>=0&&slot()-Number(s)<=1};
const dist=(a,b,c,d)=>{const R=6371000,r=x=>x*Math.PI/180,h=Math.sin(r(c-a)/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(r(d-b)/2)**2;return 2*R*Math.asin(Math.sqrt(h))};
const sessions=new Set(), hits=new Map();
const json=(res,o,c=200)=>{res.writeHead(c,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(o))};
const err=(res,m,c=400)=>json(res,{ok:false,error:m},c);
const body=req=>new Promise(r=>{let d='';req.on('data',c=>{d+=c;if(d.length>1e5)req.destroy()});req.on('end',()=>{try{r(JSON.parse(d||'{}'))}catch{r({})}})});
const authed=req=>sessions.has((/sid=([a-f0-9]+)/.exec(req.headers.cookie||'')||[])[1]);
const count=id=>db.att.filter(a=>a.l===id).length;

function report(){
  const Ls=db.lectures;
  const rows=students.map(s=>{const p=Ls.map(L=>db.att.some(a=>a.l===L.id&&a.s===s.id));
    const n=p.filter(Boolean).length,abs=Ls.length-n;
    return {id:s.id,name:s.name,p,n,abs,pct:Ls.length?Math.round(abs/Ls.length*100):0}});
  return {lectures:Ls.map(L=>({id:L.id,title:L.title,date:L.date})),rows,max:MAX_ABSENCE};
}
const csv=()=>{const R=report(),q=x=>'"'+String(x).replace(/"/g,'""')+'"';
  const h=['رقم الجلوس','الاسم',...R.lectures.map(L=>L.title+' '+L.date),'حضور','غياب','نسبة الغياب %','الحالة'];
  const lines=R.rows.map(r=>[r.id,r.name,...r.p.map(x=>x?'✓':'✗'),r.n,r.abs,r.pct,r.pct>=R.max?'محرومة':'منتظمة']);
  return '\ufeff'+[h,...lines].map(l=>l.map(q).join(',')).join('\r\n')};

async function api(req,res,p){
  const m=req.method;
  if(m==='POST'&&p==='/api/login'){const b=await body(req);
    if(b.password!==PASS)return err(res,'كلمة السر غلط',401);
    const sid=crypto.randomBytes(16).toString('hex');sessions.add(sid);
    res.setHeader('Set-Cookie','sid='+sid+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200');return json(res,{ok:true})}
  if(m==='POST'&&p==='/api/attend'){
    const ip=req.socket.remoteAddress,h=hits.get(ip)||{n:0,t:Date.now()};
    if(Date.now()-h.t>6e4){h.n=0;h.t=Date.now()}h.n++;hits.set(ip,h);if(h.n>40)return err(res,'محاولات كتير، استني شوية',429);
    const b=await body(req),L=db.lectures.find(x=>x.id===String(b.token||'').split('.')[0]);
    if(!L||!valid(b.token))return err(res,'الـ QR قديم أو غير صالح، امسحي الكود الحالي على الشاشة');
    if(L.closed)return err(res,'المحاضرة اتقفلت');
    const s=byId[String(b.studentId||'').trim()];if(!s)return err(res,'رقم الجلوس غير موجود');
    const dev=String(b.deviceId||'').slice(0,64);if(!dev)return err(res,'جهاز غير معروف');
    if(db.devices[s.id]&&db.devices[s.id]!==dev)return err(res,'رقم الجلوس ده مسجل على موبايل تاني، كلّمي الدكتور');
    if(db.att.some(a=>a.l===L.id&&a.dev===dev&&a.s!==s.id))return err(res,'الموبايل ده سجّل حضور لطالبة تانية في المحاضرة دي');
    if(db.att.some(a=>a.l===L.id&&a.s===s.id))return json(res,{ok:true,message:'حضورك متسجل قبل كده ✔'});
    const lat=+b.lat,lng=+b.lng,acc=+b.accuracy||0;
    if(!isFinite(lat)||!isFinite(lng))return err(res,'مقدرناش نحدد موقعك');
    if(acc>MAX_ACC)return err(res,'دقة الـ GPS ضعيفة ('+Math.round(acc)+'م)، اطلعي مكان مفتوح أو فعّلي الموقع الدقيق');
    const d=dist(L.lat,L.lng,lat,lng);
    if(d>L.radius)return err(res,'إنتي بره القاعة (بعيد '+Math.round(d)+' متر)');
    db.devices[s.id]=dev;db.att.push({l:L.id,s:s.id,dev,t:Date.now(),d:Math.round(d)});save();
    return json(res,{ok:true,message:'تم تسجيل حضورك يا '+s.name.split(' ').slice(0,2).join(' ')+' ✅'})}
  if(!authed(req))return err(res,'غير مصرح',401);
  let x;
  if(m==='GET'&&p==='/api/lectures')return json(res,db.lectures.map(L=>({...L,count:count(L.id)})).reverse());
  if(m==='POST'&&p==='/api/lectures'){const b=await body(req);
    if(!b.title||!isFinite(+b.lat)||!isFinite(+b.lng))return err(res,'اكتبي اسم المحاضرة وحددي موقع القاعة');
    const L={id:crypto.randomBytes(4).toString('hex'),title:String(b.title).slice(0,80),date:new Date().toLocaleDateString('ar-EG'),lat:+b.lat,lng:+b.lng,radius:Math.max(20,Math.min(500,+b.radius||100)),closed:false};
    db.lectures.push(L);save();return json(res,{ok:true,id:L.id})}
  if(x=/^\/api\/lectures\/(\w+)\/(live|close|open)$/.exec(p)){const L=db.lectures.find(l=>l.id===x[1]);if(!L)return err(res,'مش موجودة',404);
    if(x[2]==='live'){const a=db.att.filter(a=>a.l===L.id).map(a=>({name:byId[a.s].name,t:a.t}));
      return json(res,{title:L.title,open:!L.closed,token:mkToken(L.id),secondsLeft:(SLOT-Date.now()%SLOT)/1000,attendees:a,total:students.length})}
    L.closed=x[2]==='close';save();return json(res,{ok:true})}
  if(m==='POST'&&p==='/api/devices/reset'){const b=await body(req);delete db.devices[b.studentId];save();return json(res,{ok:true})}
  if(m==='GET'&&p==='/api/report')return json(res,report());
  if(m==='GET'&&p==='/api/report.csv'){res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename=attendance.csv'});return res.end(csv())}
  err(res,'مش موجود',404);
}

const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript'};
http.createServer(async(req,res)=>{
  const p=new URL(req.url,'http://x').pathname;
  try{
    if(p.startsWith('/api/'))return await api(req,res,p);
    const f=p==='/'?'student.html':p==='/doctor'?'doctor.html':p.slice(1);
    const fp=path.join(__dirname,'public',f);
    if(!fp.startsWith(path.join(__dirname,'public'))||!fs.existsSync(fp)||fs.statSync(fp).isDirectory()){res.writeHead(404);return res.end('404')}
    res.writeHead(200,{'Content-Type':types[path.extname(fp)]||'application/octet-stream'});fs.createReadStream(fp).pipe(res);
  }catch(e){console.error(e);if(!res.headersSent)err(res,'خطأ في السيرفر',500)}
}).listen(PORT,()=>console.log('Attendify on http://localhost:'+PORT+'  | الدكتور: /doctor  | كلمة السر: '+(process.env.DOCTOR_PASSWORD?'(من المتغير)':'1234')));
