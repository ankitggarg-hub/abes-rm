/* Campus Resource Planner: browser app. Talks to /api. */
(function(){
'use strict';
/* ---------- constants & helpers ---------- */
var DAYS=['Mon','Tue','Wed','Thu','Fri','Sat'];
var DAYF=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
var TYPES=['Lecture theatre','Computer lab','Seminar hall','Auditorium','Conference hall','Core lab','Tutorial room'];
var TC={'Lecture theatre':'LT','Computer lab':'LAB','Seminar hall':'SH','Auditorium':'AUD','Conference hall':'CONF','Core lab':'CORE','Tutorial room':'TUT'};
var ROLE={admin:'Administrator',hod:'Department head',head:'Head of institute',stakeholder:'Stakeholder'};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
var z2=function(n){return String(n).padStart(2,'0')};
var iso=function(d){return d.getFullYear()+'-'+z2(d.getMonth()+1)+'-'+z2(d.getDate())};
var addDays=function(s,n){var d=new Date(s+'T00:00:00');d.setDate(d.getDate()+n);return iso(d)};
var dow=function(s){return new Date(s+'T00:00:00').getDay()};
var fmtDate=function(s){return new Date(s+'T00:00:00').toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short',year:'numeric'})};
var toMin=function(t){var p=t.split(':');return +p[0]*60+ +p[1]};
var uid=function(p){return p+Math.random().toString(36).slice(2,8)};

/* ---------- state ---------- */
var KEYS=['depts','classes','slots','buildings','floors','resources','users','tt','releases','events','loads','holidays','wplans'];
var LOAD_KINDS=['Academic','Training'];
function emptyState(){var o={};KEYS.forEach(function(k){o[k]=[]});return o}
var S=emptyState();

/* ---------- server layer (talks to /api, which talks to Neon) ---------- */
var snap={},lastRaw='',chain=Promise.resolve();
var sync={state:'idle',at:null,msg:''};

function ApiError(status,message){this.status=status;this.message=message}
function api(method,path,body,bg){
  var opt={method:method,credentials:'same-origin',headers:bg?{'x-background':'1'}:{}};
  if(body!==undefined){opt.headers['content-type']='application/json';opt.body=JSON.stringify(body)}
  return fetch(path,opt).then(function(res){
    return res.json().catch(function(){return {}}).then(function(j){
      if(!res.ok)throw new ApiError(res.status,j.error||'The server returned an error ('+res.status+').');
      return j;
    });
  },function(){throw new ApiError(0,'Cannot reach the server. Check your connection and try again.')});
}
function setSnapshot(){KEYS.forEach(function(k){snap[k]={};S[k].forEach(function(r){snap[k][r.id]=JSON.stringify(r)})})}
function applyData(res){
  var ns=emptyState();KEYS.forEach(function(k){ns[k]=res.data[k]||[]});
  S=ns;ui.userId=res.user.id;lastRaw=JSON.stringify(res.data);setSnapshot();
}
function pendingOps(){
  var ops=[];
  KEYS.forEach(function(k){
    var cur={},up=[],rm=[];
    S[k].forEach(function(r){var j=JSON.stringify(r);cur[r.id]=1;if(snap[k][r.id]!==j)up.push(r)});
    Object.keys(snap[k]).forEach(function(id){if(!cur[id])rm.push(id)});
    if(up.length||rm.length)ops.push({key:k,upsert:up,remove:rm});
  });
  return ops;
}
function sendOps(){
  var ops=pendingOps();
  return ops.reduce(function(p,op){return p.then(function(){
    return api('PUT','/api/data/'+op.key,{upsert:op.upsert,remove:op.remove}).then(function(){
      op.upsert.forEach(function(r){
        if(op.key==='users'&&r.password){var live=S.users.filter(function(u){return u.id===r.id})[0];if(live)delete live.password;var c=Object.assign({},r);delete c.password;snap.users[r.id]=JSON.stringify(c)}
        else snap[op.key][r.id]=JSON.stringify(r);
      });
      op.remove.forEach(function(id){delete snap[op.key][id]});
    });
  })},Promise.resolve());
}
function save(){
  setSync('saving');
  chain=chain.then(sendOps).then(function(){setSync('ok')},function(err){
    if(err.status===401){signedOut();return}
    if(err.status===0){setSync('error',err.message);return}
    /* the server refused the change: show why and go back to what the server has */
    toast(err.message,true);
    return loadAll(true).catch(function(){setSync('error',err.message)});
  });
}
function loadAll(silent,bg){
  if(!silent)setSync('loading');
  return api('GET','/api/data',undefined,bg).then(function(res){
    var raw=JSON.stringify(res.data);
    if(silent&&raw===lastRaw&&pendingOps().length===0){setSync('ok');return}
    applyData(res);ui.booting=false;setSync('ok');render();
  });
}
function signedOut(msg){S=emptyState();snap={};ui.userId=null;ui.booting=false;ui.modal=null;ui.loginErr=msg||'';sync.state='idle';render()}
function boot(){
  return api('GET','/api/auth/me').then(function(){return loadAll(false)}).catch(function(err){
    if(err.status===401)signedOut();
    else{ui.booting=false;ui.loginErr=err.message;signedOut(err.message)}
  });
}
function setSync(state,msg){sync.state=state;sync.msg=msg||'';if(state==='ok')sync.at=new Date();updateSync()}
function syncHTML(){
  if(!ui.userId)return '';
  var t=sync.at?sync.at.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):'';
  if(sync.state==='loading')return '<span class="sync busy">Loading…</span>';
  if(sync.state==='saving')return '<span class="sync busy">Saving…</span>';
  if(sync.state==='error')return '<span class="sync bad" title="'+esc(sync.msg)+'">Not saved</span><button class="btn sm" data-act="syncnow">Retry</button>';
  return '<span class="sync ok">Saved · '+t+'</span>';
}
function updateSync(){var el=document.getElementById('sync');if(el)el.innerHTML=syncHTML()}

var today=iso(new Date());
var ui={booting:true,loginErr:'',loginBusy:false,userId:null,tab:'overview',mtab:'depts',ttDept:null,ttRes:null,ttMode:'week',ttDay:0,
  trDept:null,trView:'plan',rpDept:null,rpPeriod:'all',rpKind:'',trClass:'',trWeek:mondayOf(today),trMonth:today.slice(0,7),avDate:today,lnDate:today,lnFrom:null,lnTo:null,lnType:'',avFrom:null,avTo:null,avType:'',avCap:'',avBld:'',avFl:'',mf:{},chDept:null,chClass:'',chFrom:today,chTo:today,chSlotA:'',chSlotB:'',chReason:'Industrial visit',chNote:'',modal:null,confirm:null,evShowPast:false};

/* ---------- selectors ---------- */
var slotList=function(){return S.slots.slice().sort(function(a,b){return a.start.localeCompare(b.start)})};
var isBrk=function(id){var x=S.slots.filter(function(s){return s.id===id})[0];return !!(x&&x.isBreak)};
var slotById=function(id){return S.slots.filter(function(s){return s.id===id})[0]};
var bldById=function(id){return S.buildings.filter(function(b){return b.id===id})[0]};
var floorById=function(id){return S.floors.filter(function(f){return f.id===id})[0]};
var floorList=function(){return S.floors.slice().sort(function(a,b){return a.level-b.level})};
function locStr(r){var b=bldById(r.buildingId),f=floorById(r.floorId);return (b?b.name:'No building')+' · '+(f?f.name:'no floor')}
var classById=function(id){return S.classes.filter(function(c){return c.id===id})[0]};
function classLabel(id){var c=classById(id),d=c&&deptById(c.deptId);return c?(d?d.code:'?')+' '+c.year+c.section:String(id||'–')}
function classFull(c){var d=deptById(c.deptId);return (d?d.code:'?')+' · Year '+c.year+' · Section '+c.section}
function tClassesOf(deptId){return classesOf(deptId).filter(function(c){return c.tracked})}
function classesOf(deptId){return S.classes.filter(function(c){return c.deptId===deptId}).sort(function(a,b){return a.year-b.year||a.section.localeCompare(b.section)})}
var resById=function(id){return S.resources.filter(function(r){return r.id===id})[0]};
var deptById=function(id){return S.depts.filter(function(d){return d.id===id})[0]};
var isLunch=function(deptId,slotId){var d=S.depts.filter(function(x){return x.id===deptId})[0];return !!(d&&d.lunchSlots&&d.lunchSlots.indexOf(slotId)>-1)};
var lunchText=function(d){var l=slotList().filter(function(x){return d&&d.lunchSlots&&d.lunchSlots.indexOf(x.id)>-1});return l.length?l.map(function(x){return x.label+' '+x.start+'–'+x.end}).join(', '):''};
var me=function(){return S.users.filter(function(u){return u.id===ui.userId})[0]||{id:'',name:'',role:'stakeholder',deptId:null,email:''}};
var canBook=function(){return ['admin','head','stakeholder'].indexOf(me().role)>-1};
var canApprove=function(){return ['admin','head'].indexOf(me().role)>-1};
function slotRange(a,b){var l=slotList(),i=l.map(function(s){return s.id}).indexOf(a),j=l.map(function(s){return s.id}).indexOf(b);if(i<0)i=0;if(j<0)j=l.length-1;if(i>j){var t=i;i=j;j=t}return l.slice(i,j+1).filter(function(x){return !x.isBreak})}
function timeRange(ids){var l=slotList().filter(function(s){return ids.indexOf(s.id)>-1});return l.length?l[0].start+'–'+l[l.length-1].end:''}
var REASONS=['Industrial visit','Placement activity','Seminar or workshop','Exam or test','Holiday','Faculty on leave','Other'];
function relFor(ttId,date){for(var i=0;i<S.releases.length;i++){var r=S.releases[i];if(r.ttId===ttId&&r.date===date)return r}return null}
function awayAt(resId,date,slotId){
  var d=dow(date);if(d<1)return null;
  for(var i=0;i<S.tt.length;i++){var t=S.tt[i];if(t.resId===resId&&t.day===d-1&&t.slotId===slotId){var rl=relFor(t.id,date);if(rl)return {t:t,rel:rl}}}
  return null;
}
function deptIdsOf(u){return u&&u.deptId?[u.deptId].concat(u.moreDeptIds||[]):[]}
function myDepts(){return deptIdsOf(me())}
function hodDept(sel){var m=myDepts();return m.indexOf(sel)>-1?sel:(m[0]||null)}
function deptLabel(ids){return ids.map(function(i){var x=deptById(i);return x?x.code:''}).filter(Boolean).join(' / ')}
function canRelease(t){var u=me();if(u.role==='admin'||u.role==='head')return true;if(u.role!=='hod')return false;var c=classById(t.classId);return !!c&&myDepts().indexOf(c.deptId)>-1}
function busyAt(resId,date,slotId){
  var d=dow(date),i;
  if(d>=1&&d<=6){for(i=0;i<S.tt.length;i++){var t=S.tt[i];if(t.resId===resId&&t.day===d-1&&t.slotId===slotId){if(relFor(t.id,date))continue;return {kind:'class',e:t}}}}
  for(i=0;i<S.events.length;i++){var v=S.events[i];if(v.resId===resId&&v.date===date&&v.status!=='rejected'&&v.slotIds.indexOf(slotId)>-1)return {kind:'event',ev:v}}
  return null;
}
function ensure(){
  var sl=slotList();
  if(S.users.length&&!S.users.some(function(u){return u.id===ui.userId}))ui.userId=S.users[0].id;
  if(!ui.avFrom||!slotById(ui.avFrom))ui.avFrom=sl.length?sl[0].id:null;
  if(!ui.avTo||!slotById(ui.avTo))ui.avTo=sl.length?sl[Math.min(1,sl.length-1)].id:null;
  if(!ui.lnFrom||!slotById(ui.lnFrom))ui.lnFrom=ui.avFrom;
  if(!ui.lnTo||!slotById(ui.lnTo))ui.lnTo=ui.avTo;
  if(!ui.ttDept||!deptById(ui.ttDept))ui.ttDept=S.depts.length?S.depts[0].id:null;
}
function tabsFor(r){
  var pend=S.events.filter(function(e){return e.status==='pending'}).length;
  var ev=['events','Events'+(canApprove()&&pend?'<span class="count">'+pend+'</span>':'')];
  if(r==='admin')return [['overview','Overview'],['avail','Availability'],ev,['timetable','Timetables'],['classes','Rooms by class'],['changes','Class changes'],['track','Academic tracker'],['masters','Masters']];
  if(r==='hod')return [['overview','Overview'],['timetable','My timetable'],['changes','Class changes'],['classes','Rooms by class'],['avail','Availability'],['lend','Lend a venue'],['track','Academic tracker'],ev];
  if(r==='head')return [['overview','Overview'],['avail','Find a venue'],['changes','Class changes'],['classes','Rooms by class'],['track','Academic tracker'],ev];
  return [['overview','Overview'],['classes','Rooms by class'],['avail','Find a venue'],ev];
}

/* ---------- small html pieces ---------- */
var tcode=function(t){return '<span class="tcode">'+TC[t]+'</span>'};
function dtag(id){var d=deptById(id);return d?'<span class="dtag" style="--h:'+d.h+'">'+esc(d.code)+'</span>':'<span class="dtag central">Central pool</span>'}
function awayNote(resId,date,win){
  var seen={},out=[];win.forEach(function(id){var a=awayAt(resId,date,id);if(a&&!seen[a.t.id]){seen[a.t.id]=1;out.push(esc(classLabel(a.t.classId))+' ('+esc(a.rel.reason.toLowerCase())+')')}});
  return out.length?'<div class="meta">Normally in use: '+out.join(', ')+' is away.</div>':'';
}
function statusBadge(s){return s==='confirmed'?'<span class="badge b-ok">Confirmed</span>':s==='pending'?'<span class="badge b-wait">Awaiting approval</span>':'<span class="badge b-no">Declined</span>'}
var fld=function(label,inner,cls){return '<label class="fld '+(cls||'')+'"><span>'+label+'</span>'+inner+'</label>'};
var tin=function(n,v,x){return '<input id="f-'+n+'" name="'+n+'" value="'+esc(v)+'" '+(x||'')+'>'};
var sel=function(n,opts,v){return '<select id="f-'+n+'" name="'+n+'">'+opts.map(function(o){return '<option value="'+esc(o[0])+'"'+(String(o[0])===String(v)?' selected':'')+'>'+esc(o[1])+'</option>'}).join('')+'</select>'};
var slotOpts=function(){return slotList().filter(function(s){return !s.isBreak}).map(function(s){return [s.id,s.label+'  '+s.start+'–'+s.end]})};
var deptOpts=function(central){return (central?[['',central]]:[]).concat(S.depts.map(function(d){return [d.id,d.code+' – '+d.name]}))};
var emptyBox=function(m){return '<div class="empty">'+m+'</div>'};
var legend='<div class="legend"><span><i style="background:var(--free-soft);border-color:var(--free-line)"></i>Free</span><span><i style="background:hsl(205 var(--dept-s) var(--dept-l))"></i>Class (department colour)</span><span><i style="background:var(--event-bg);border-color:var(--event)"></i>Event</span><span><i style="background:var(--free-bg);border-color:var(--free)"></i>Free, class away</span></div>';

/* ---------- views ---------- */
function vOverview(){
  var u=me(),sl=slotList(),nowD=new Date(),m=nowD.getHours()*60+nowD.getMinutes();
  var cur=sl.filter(function(s){return toMin(s.start)<=m&&m<toMin(s.end)})[0];
  var next=sl.filter(function(s){return toMin(s.start)>m})[0];
  var freeNow=cur?S.resources.filter(function(r){return !busyAt(r.id,today,cur.id)}):[];
  var up=S.events.filter(function(e){return e.date>=today&&e.status!=='rejected'}).sort(function(a,b){return a.date.localeCompare(b.date)}).slice(0,6);
  var weekEv=S.events.filter(function(e){return e.date>=today&&e.date<=addDays(today,6)&&e.status!=='rejected'}).length;
  var pend=S.events.filter(function(e){return e.status==='pending'}).length;
  var perWeek=6*sl.filter(function(s){return !s.isBreak}).length;
  var bars=S.depts.map(function(d){
    var rs=S.resources.filter(function(r){return r.deptId===d.id});
    var used=S.tt.filter(function(t){return rs.some(function(r){return r.id===t.resId})}).length;
    var cap=rs.length*perWeek,p=cap?Math.round(used/cap*100):0;
    return '<div class="row"><div class="lbl"><span>'+dtag(d.id)+' '+esc(d.name)+'</span><span class="mono muted">'+rs.length+' rooms · '+p+'%</span></div><div class="track"><div class="fill" style="--h:'+d.h+';width:'+p+'%"></div></div></div>';
  }).join('');
  var central=S.resources.filter(function(r){return !r.deptId}).length;
  var freeHtml;
  if(cur&&cur.isBreak){freeHtml='<p class="note">'+esc(cur.label)+' ('+cur.start+'–'+cur.end+') is a break. No classes run; every venue is quiet until the next period.</p>'}
  else if(cur){
    freeHtml='<p class="note" style="margin:0 0 8px">'+esc(cur.label)+' is running now ('+cur.start+'–'+cur.end+'). '+freeNow.length+' of '+S.resources.length+' venues are free.</p>'+
      (dow(today)===0?'<p class="note">Sunday: no classes are scheduled.</p>':'')+
      '<div class="chips">'+freeNow.slice(0,16).map(function(r){return '<span class="chip">'+esc(r.name)+'</span>'}).join('')+(freeNow.length>16?'<button class="link" data-act="seefree" data-slot="'+cur.id+'">+'+(freeNow.length-16)+' more</button>':'')+'</div><p style="margin:10px 0 0"><button class="link" data-act="seefree" data-slot="'+cur.id+'">Filter by building, floor or type in Availability →</button></p>';
  } else if(next){freeHtml='<p class="note">No period is running. The next one, '+esc(next.label)+', starts at '+next.start+'. Open Availability to plan ahead.</p>'}
  else {freeHtml='<p class="note">Today\'s periods are over. Open Availability to check tomorrow.</p>'}
  return '<div class="head"><div><h2>Good to see you, '+esc(u.name.split(' (')[0])+'</h2><p>'+({admin:'Set up masters, allocate venues to departments and keep an eye on usage.',hod:'Plan your department’s daily and weekly timetable on the venues allocated to you.',head:'See which halls, labs and theatres are free and approve event requests.',stakeholder:'Find a free venue for your event and send a booking request.'})[u.role]+'</p></div></div>'+
  '<div class="strip"><div><b>'+S.resources.length+'</b><span>Venues in inventory</span></div><div><b>'+central+'</b><span>Unallocated, open for events</span></div><div><b>'+weekEv+'</b><span>Events in the next 7 days</span></div><div><b>'+pend+'</b><span>Requests awaiting approval</span></div></div>'+
  '<div class="cols"><section class="panel"><h3>Free right now</h3>'+freeHtml+'</section>'+
  '<section class="panel"><h3>Upcoming events</h3>'+(up.length?'<ul class="list">'+up.map(function(e){var r=resById(e.resId);return '<li><span><b>'+esc(e.title)+'</b><br><span class="note">'+esc(r?r.name:'Removed venue')+' · '+fmtDate(e.date)+' · <span class="mono">'+timeRange(e.slotIds)+'</span></span></span>'+statusBadge(e.status)+'</li>'}).join('')+'</ul>':emptyBox('No events are booked yet. Use Availability to book one.'))+'</section></div>'+
  freedPanel()+lentToPanel()+'<section class="panel"><h3>Weekly timetable load by department</h3>'+(S.depts.length?'<div class="ub">'+bars+'</div>':emptyBox('Add departments in Masters.'))+'<p class="note" style="margin-bottom:0">Share of the '+perWeek+' weekly slots per venue that have a class scheduled.</p></section>';
}

function freedPanel(){
  var list=S.releases.filter(function(r){return r.date>=today&&r.date<=addDays(today,6)}).map(function(r){var t=S.tt.filter(function(x){return x.id===r.ttId})[0];return t?{r:r,t:t}:null}).filter(Boolean).sort(function(a,b){return a.r.date.localeCompare(b.r.date)||(slotById(a.t.slotId)||{start:''}).start.localeCompare((slotById(b.t.slotId)||{start:''}).start)});
  var rows=list.slice(0,10).map(function(x){var v=resById(x.t.resId),s=slotById(x.t.slotId);return '<li><span><b>'+esc(v?v.name:'Removed venue')+'</b> <span class="mono">'+(s?s.start+'–'+s.end:'')+'</span><br><span class="note">'+fmtDate(x.r.date)+' · '+esc(classLabel(x.t.classId))+' away: '+esc(x.r.reason)+(x.r.note?' ('+esc(x.r.note)+')':'')+'</span></span><span class="badge b-ok">Free</span></li>'}).join('');
  return '<section class="panel"><h3>Spaces freed by class changes (next 7 days)</h3>'+(list.length?'<ul class="list">'+rows+'</ul>'+(list.length>10?'<p class="note" style="margin:8px 0 0">+'+(list.length-10)+' more. Check Availability for a given day.</p>':''):'<p class="note" style="margin:0">No scheduled class is released. When a class goes on a visit or to another activity, its venue shows up here as free.</p>')+'</section>';
}

function chTargets(){
  var u=me(),dept=u.role==='hod'?hodDept(ui.chDept):ui.chDept,out=[];
  if(!dept||!ui.chFrom||!ui.chTo||ui.chTo<ui.chFrom)return out;
  var sl=slotList().map(function(x){return x.id}),a=sl.indexOf(ui.chSlotA),b=sl.indexOf(ui.chSlotB);if(a<0)a=0;if(b<0)b=sl.length-1;if(a>b){var tmp=a;a=b;b=tmp}
  var win=sl.slice(a,b+1);
  for(var d=ui.chFrom,n=0;d<=ui.chTo&&n<63;d=addDays(d,1),n++){var w=dow(d);if(w===0)continue;
    S.tt.forEach(function(t){
      if(t.day!==w-1||win.indexOf(t.slotId)<0)return;
      if(ui.chClass&&t.classId!==ui.chClass)return;
      var c=classById(t.classId);if(!c||c.deptId!==dept)return;
      if(relFor(t.id,d))return;
      out.push({t:t,date:d});
    });
  }
  return out;
}
function vChanges(){
  var u=me(),sl=slotList();
  if(!sl.length)return emptyBox('No time slots are defined yet.');
  if(u.role!=='hod'&&(!ui.chDept||!deptById(ui.chDept)))ui.chDept=S.depts.length?S.depts[0].id:null;
  var cs=slotOpts();
  if(!ui.chSlotA||!slotById(ui.chSlotA)||isBrk(ui.chSlotA))ui.chSlotA=cs.length?cs[0][0]:sl[0].id;
  if(!ui.chSlotB||!slotById(ui.chSlotB)||isBrk(ui.chSlotB))ui.chSlotB=cs.length?cs[cs.length-1][0]:sl[sl.length-1].id;
  var dept=u.role==='hod'?hodDept(ui.chDept):ui.chDept;
  if(ui.chClass&&(!classById(ui.chClass)||classById(ui.chClass).deptId!==dept))ui.chClass='';
  var cls=classesOf(dept),tg=chTargets();
  var f='<form class="panel" data-chform="1" novalidate><h3>Release scheduled classes</h3><p class="note" style="margin:0 0 12px">Use this when a class is somewhere else on a particular day: an industrial visit, a placement drive, a seminar, an exam. Their regular room shows as free on those dates, so anyone who is allowed to book can use it. The weekly timetable itself does not change.</p><div class="filters">'+
    ((u.role==='hod'&&myDepts().length<2)?'':'<label>Department<select data-set="chDept">'+S.depts.filter(function(d){return u.role!=='hod'||myDepts().indexOf(d.id)>-1}).map(function(d){return '<option value="'+d.id+'"'+(d.id===dept?' selected':'')+'>'+esc(d.name)+'</option>'}).join('')+'</select></label>')+
    '<label>Year and section<select name="cls" data-set="chClass"><option value="">All sections of the department</option>'+cls.map(function(c){return '<option value="'+c.id+'"'+(c.id===ui.chClass?' selected':'')+'>'+esc(classFull(c))+'</option>'}).join('')+'</select></label>'+
    '<label>From date<input type="date" name="from" value="'+ui.chFrom+'" data-set="chFrom" required></label>'+
    '<label>To date<input type="date" name="to" value="'+ui.chTo+'" data-set="chTo" required></label>'+
    '<label>From period<select data-set="chSlotA">'+slotOpts().map(function(o){return '<option value="'+o[0]+'"'+(o[0]===ui.chSlotA?' selected':'')+'>'+esc(o[1])+'</option>'}).join('')+'</select></label>'+
    '<label>To period<select data-set="chSlotB">'+slotOpts().map(function(o){return '<option value="'+o[0]+'"'+(o[0]===ui.chSlotB?' selected':'')+'>'+esc(o[1])+'</option>'}).join('')+'</select></label>'+
    '<label>Reason<select name="reason" data-set="chReason">'+REASONS.map(function(x){return '<option'+(x===ui.chReason?' selected':'')+'>'+x+'</option>'}).join('')+'</select></label>'+
    '<label>Note (where, who)<input type="text" name="note" maxlength="300" value="'+esc(ui.chNote)+'" data-set="chNote" placeholder="e.g. Visit to Infosys, Pune" style="min-width:220px"></label></div>'+
    '<p class="note" style="margin:12px 0"><b>'+tg.length+'</b> scheduled class'+(tg.length===1?'':'es')+' will be released'+(ui.chTo<ui.chFrom?'. The end date is before the start date.':(tg.length?' ('+tg.slice(0,3).map(function(x){var v=resById(x.t.resId),s=slotById(x.t.slotId);return esc(classLabel(x.t.classId))+' '+fmtDate(x.date).split(',')[0]+' '+(s?s.start:'')+' '+(v?esc(v.name):'')}).join('; ')+(tg.length>3?'; …':'')+')':'. Nothing is scheduled for this selection, or it is already released.'))+'</p>'+
    '<button class="btn primary" type="submit"'+(tg.length?'':' disabled')+'>Release '+tg.length+' class'+(tg.length===1?'':'es')+'</button></form>';
  var up=S.releases.filter(function(r){return r.date>=today}).map(function(r){var t=S.tt.filter(function(x){return x.id===r.ttId})[0];return t?{r:r,t:t}:null}).filter(Boolean).sort(function(a,b){return a.r.date.localeCompare(b.r.date)});
  var rows=up.map(function(x){var v=resById(x.t.resId),s=slotById(x.t.slotId);
    return '<tr><td class="mono" style="white-space:nowrap">'+fmtDate(x.r.date)+'</td><td class="mono" style="white-space:nowrap">'+(s?s.start+'–'+s.end:'')+'</td><td>'+(v?tcode(v.type)+esc(v.name):'Removed venue')+'</td><td>'+esc(classLabel(x.t.classId))+'<br><span class="note">'+esc(x.t.title)+'</span></td><td><b>'+esc(x.r.reason)+'</b>'+(x.r.note?'<br><span class="note">'+esc(x.r.note)+'</span>':'')+'</td><td class="note">'+esc(x.r.by)+'</td><td class="act">'+(canRelease(x.t)?'<button class="btn sm" data-act="unrel" data-id="'+x.r.id+'">Restore class</button>':'')+'</td></tr>'}).join('');
  var list='<section><h3 style="margin-bottom:10px">Upcoming released classes</h3>'+(up.length?'<div class="scroll"><table class="tbl"><thead><tr><th>Date</th><th>Time</th><th>Venue freed</th><th>Class</th><th>Reason</th><th>Released by</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>':emptyBox('Nothing is released yet.'))+'</section>';
  return '<div class="head"><div><h2>Class changes</h2><p>Mark classes that will not use their regular room on a given date so the space can be reused.</p></div></div>'+f+list;
}

function vAvail(){
  var sl=slotList(),date=ui.avDate;
  if(!sl.length)return emptyBox('No time slots are defined yet. Ask the administrator to add them in Masters.');
  var win=slotRange(ui.avFrom,ui.avTo).map(function(s){return s.id});
  var cap=+ui.avCap||0;
  var rs=S.resources.filter(function(r){return (!ui.avType||r.type===ui.avType)&&(!ui.avBld||r.buildingId===ui.avBld)&&(!ui.avFl||r.floorId===ui.avFl)&&r.capacity>=cap}).sort(function(a,b){return TYPES.indexOf(a.type)-TYPES.indexOf(b.type)||a.capacity-b.capacity});
  var free=rs.filter(function(r){return win.every(function(id){return !busyAt(r.id,date,id)})});
  var first=slotById(win[0]),last=slotById(win[win.length-1]);
  var filters='<div class="panel"><div class="filters">'+
    '<label>Date<input type="date" id="av-date" value="'+date+'" data-set="avDate"></label>'+
    '<div class="seg"><button class="btn sm" data-act="avday" data-n="-1">Prev day</button><button class="btn sm" data-act="avday" data-n="0">Today</button><button class="btn sm" data-act="avday" data-n="1">Next day</button></div>'+
    '<label>From<select id="av-from" data-set="avFrom">'+slotOpts().map(function(o){return '<option value="'+o[0]+'"'+(o[0]===ui.avFrom?' selected':'')+'>'+esc(o[1])+'</option>'}).join('')+'</select></label>'+
    '<label>To<select id="av-to" data-set="avTo">'+slotOpts().map(function(o){return '<option value="'+o[0]+'"'+(o[0]===ui.avTo?' selected':'')+'>'+esc(o[1])+'</option>'}).join('')+'</select></label>'+
    '<label>Venue type<select id="av-type" data-set="avType"><option value="">All types</option>'+TYPES.map(function(t){return '<option'+(t===ui.avType?' selected':'')+'>'+t+'</option>'}).join('')+'</select></label>'+
    '<label>Building<select id="av-bld" data-set="avBld"><option value="">All buildings</option>'+bldOpts().map(function(o){return '<option value="'+o[0]+'"'+(o[0]===ui.avBld?' selected':'')+'>'+esc(o[1])+'</option>'}).join('')+'</select></label>'+
    '<label>Floor<select id="av-fl" data-set="avFl"><option value="">All floors</option>'+floorOpts().map(function(o){return '<option value="'+o[0]+'"'+(o[0]===ui.avFl?' selected':'')+'>'+esc(o[1])+'</option>'}).join('')+'</select></label>'+
    '<label>Seats needed<input type="number" id="av-cap" min="0" step="10" placeholder="Any" value="'+esc(ui.avCap)+'" data-set="avCap" style="width:110px"></label>'+
    '</div></div>';
  var cards=free.length?'<div class="cards">'+free.map(function(r){
    return '<div class="card vfree"><h4>'+tcode(r.type)+esc(r.name)+'</h4><div class="meta">'+esc(r.type)+' · '+esc(locStr(r))+'</div><div><b class="mono">'+r.capacity+'</b> seats · '+dtag(r.deptId)+'</div><div class="meta">'+esc(r.equipment||'No equipment listed')+'</div>'+
      awayNote(r.id,date,win)+(canBook()?'<div><button class="btn primary sm" data-act="book" data-res="'+r.id+'" data-from="'+win[0]+'" data-to="'+win[win.length-1]+'">Book for this window</button></div>':'')+'</div>';
  }).join('')+'</div>':emptyBox('Nothing matches for the whole window. Try fewer periods, a smaller seat count or another date.');
  var head='<tr><th class="rh">Venue</th>'+sl.map(function(s){return '<th class="'+(win.indexOf(s.id)>-1?'hl':'')+'">'+esc(s.label)+'<small>'+s.start+'–'+s.end+'</small></th>'}).join('')+'</tr>';
  var body=rs.map(function(r){
    return '<tr><th class="rh">'+tcode(r.type)+esc(r.name)+'<small>'+r.capacity+' seats · '+(deptById(r.deptId)?deptById(r.deptId).code:'Central')+'</small></th>'+sl.map(function(s){
      if(s.isBreak)return '<td><div class="cell brk">Break</div></td>';
      var b=busyAt(r.id,date,s.id);
      if(!b){var aw=awayAt(r.id,date,s.id);return '<td><'+(canBook()?'button data-act="book" data-res="'+r.id+'" data-from="'+s.id+'" data-to="'+s.id+'" class="cell free vfree pick'+(aw?' rel':'')+'" title="Book '+esc(r.name)+' at '+s.start+(aw?' (class away: '+esc(classLabel(aw.t.classId)+', '+aw.rel.reason)+')':'')+'"':'div class="cell free vfree'+(aw?' rel':'')+'"'+(aw?' title="'+esc('Class away: '+classLabel(aw.t.classId)+', '+aw.rel.reason)+'"':''))+'><i>Free</i>'+(aw?'<em>'+esc(classLabel(aw.t.classId))+' away</em>':'')+'</'+(canBook()?'button':'div')+'></td>'}
      if(b.kind==='class'){var d=deptById(r.deptId);return '<td><div class="cell cls" style="--h:'+(d?d.h:200)+'" title="'+esc(b.e.title+(b.e.faculty?' · '+b.e.faculty:''))+'"><b>'+esc(b.e.title)+'</b><span>'+esc(classLabel(b.e.classId))+'</span></div></td>'}
      return '<td><div class="cell ev"><b>'+esc(b.ev.title)+'</b><span>'+(b.ev.status==='pending'?'Requested':'Event')+'</span></div></td>';
    }).join('')+'</tr>';
  }).join('');
  return '<div class="head"><div><h2>'+(me().role==='hod'||me().role==='admin'?'Availability':'Find a venue')+'</h2><p>Pick a date and a window of periods. Free means no class in the weekly timetable and no event booked.</p></div></div>'+filters+
    '<section><h3 style="margin-bottom:10px">'+free.length+' free from '+first.start+' to '+last.end+' on '+fmtDate(date)+'</h3>'+(dow(date)===0?'<p class="note">Sunday: no timetable applies.</p>':'')+cards+'</section>'+
    '<section><div class="head" style="margin-bottom:8px"><h3>Day view</h3>'+legend+'</div>'+(rs.length?'<div class="scroll"><table class="grid"><thead>'+head+'</thead><tbody>'+body+'</tbody></table></div>':emptyBox('No venue matches these filters.'))+'</section>';
}

function evRow(e){
  var r=resById(e.resId),k='ev:'+e.id,mine=e.by===me().name,lender=e.lentDeptId&&me().role==='hod'&&myDepts().indexOf(e.lentDeptId)>-1;
  var acts='';
  if(e.status==='pending'&&canApprove())acts+='<button class="btn sm primary" data-act="approve" data-id="'+e.id+'">Approve</button> <button class="btn sm" data-act="reject" data-id="'+e.id+'">Decline</button> ';
  if(canApprove()||mine||lender)acts+='<button class="btn sm danger" data-act="del" data-k="'+k+'">'+(ui.confirm===k?'Confirm cancel':'Cancel event')+'</button>';
  return '<tr><td class="mono" style="white-space:nowrap">'+fmtDate(e.date)+'</td><td class="mono" style="white-space:nowrap">'+timeRange(e.slotIds)+'</td><td>'+(r?tcode(r.type)+esc(r.name):'Removed venue')+'</td><td><b>'+esc(e.title)+'</b>'+(e.notes?'<br><span class="note">'+esc(e.notes)+'</span>':'')+'</td><td>'+esc(e.by)+(e.lentDeptId?'<br><span class="note">Lent by '+(deptById(e.lentDeptId)?esc(deptById(e.lentDeptId).code):'')+(e.lentBy?' · '+esc(e.lentBy):'')+'</span>':'')+'<br><span class="note">'+(e.attendees||'–')+' expected</span></td><td>'+statusBadge(e.status)+'</td><td class="act">'+acts+'</td></tr>';
}
/* ---------- lending a department's venue ---------- */
function hodOf(deptId){return S.users.filter(function(u){return u.role==='hod'&&deptIdsOf(u).indexOf(deptId)>-1})[0]||null}
function lendToHTML(cur){
  var u=me(),o='<option value="">Choose who it is for…</option>',ds=S.depts.filter(function(d){return myDepts().indexOf(d.id)<0}),hs=S.users.filter(function(x){return x.role==='hod'&&x.id!==u.id&&x.deptId&&myDepts().indexOf(x.deptId)<0});
  o+='<optgroup label="Department">'+ds.map(function(d){var h=hodOf(d.id);return '<option value="d:'+d.id+'"'+(cur==='d:'+d.id?' selected':'')+'>'+esc(d.code+' – '+d.name+(h?' (HoD: '+h.name+')':''))+'</option>'}).join('')+'</optgroup>';
  o+='<optgroup label="Head of department">'+hs.map(function(h){return '<option value="h:'+h.id+'"'+(cur==='h:'+h.id?' selected':'')+'>'+esc(h.name+' · '+deptLabel(deptIdsOf(h)))+'</option>'}).join('')+'</optgroup>';
  o+='<optgroup label="Someone else"><option value="x"'+(cur==='x'?' selected':'')+'>Faculty, guest or organisation (type the name below)</option></optgroup>';
  return '<select id="f-toWho" name="toWho">'+o+'</select>';
}
function openLend(resId,from,to,date){
  open('lend',{resId:resId,date:date||ui.lnDate,from:from||ui.lnFrom,to:to||ui.lnTo,toWho:'',forName:'',title:'',attendees:'',notes:''});
}
function vLend(){
  var u=me(),md=myDepts(),d=deptById(u.deptId),sl=slotList(),lbl=deptLabel(md);
  var head='<div class="head"><div><h2>Lend a venue</h2><p>When one of your department’s venues is free on a date and time, you can book it for another department, a head of department or an outside guest. It is confirmed straight away and the slot is blocked for everyone else.</p></div></div>';
  if(!d)return head+emptyBox('No department is linked to this account. Ask the administrator to set it in Masters → Users.');
  var own=S.resources.filter(function(r){return md.indexOf(r.deptId)>-1});
  if(!own.length)return head+emptyBox(esc(lbl)+' has no venues yet. The administrator can allocate venues in Masters → Allocation.');
  if(!sl.length)return head+emptyBox('No time slots are defined yet.');
  var date=ui.lnDate,win=slotRange(ui.lnFrom,ui.lnTo).map(function(s){return s.id});
  var rs=own.filter(function(r){return !ui.lnType||r.type===ui.lnType}).sort(function(a,b){return TYPES.indexOf(a.type)-TYPES.indexOf(b.type)||a.capacity-b.capacity});
  var free=rs.filter(function(r){return win.every(function(id){return !busyAt(r.id,date,id)})});
  var first=slotById(win[0]),last=slotById(win[win.length-1]);
  var opt=function(v){return slotOpts().map(function(o){return '<option value="'+o[0]+'"'+(o[0]===v?' selected':'')+'>'+esc(o[1])+'</option>'}).join('')};
  var filters='<div class="panel"><div class="filters">'+
    '<label>Date<input type="date" id="ln-date" value="'+date+'" data-set="lnDate"></label>'+
    '<label>From<select id="ln-from" data-set="lnFrom">'+opt(ui.lnFrom)+'</select></label>'+
    '<label>To<select id="ln-to" data-set="lnTo">'+opt(ui.lnTo)+'</select></label>'+
    '<label>Venue type<select id="ln-type" data-set="lnType"><option value="">All types</option>'+TYPES.filter(function(t){return own.some(function(r){return r.type===t})}).map(function(t){return '<option'+(t===ui.lnType?' selected':'')+'>'+t+'</option>'}).join('')+'</select></label>'+
    '</div></div>';
  var cards;
  if(date<today)cards=emptyBox('That date has passed. Choose today or a later date.');
  else if(!win.length)cards=emptyBox('Choose a time that is not a break.');
  else cards=free.length?'<div class="cards">'+free.map(function(r){
    return '<div class="card vfree"><h4>'+tcode(r.type)+esc(r.name)+'</h4><div class="meta">'+esc(r.type)+' · '+esc(locStr(r))+'</div><div><b class="mono">'+r.capacity+'</b> seats'+(md.length>1?' · '+dtag(r.deptId):'')+'</div><div class="meta">'+esc(r.equipment||'No equipment listed')+'</div>'+awayNote(r.id,date,win)+'<div><button class="btn primary sm" data-act="lend" data-res="'+r.id+'">Lend this venue</button></div></div>';
  }).join('')+'</div>':emptyBox('None of '+esc(lbl)+'’s venues is free for the whole of that time. Try another time or date.');
  var out=S.events.filter(function(e){return md.indexOf(e.lentDeptId)>-1&&e.date>=today}).sort(function(a,b){return a.date.localeCompare(b.date)});
  var th='<thead><tr><th>Date</th><th>Time</th><th>Venue</th><th>Event</th><th>Lent to</th><th>Status</th><th></th></tr></thead>';
  var list='<section><h3 style="margin-bottom:10px">Lent out by '+esc(lbl)+'</h3>'+(out.length?'<div class="scroll"><table class="tbl">'+th+'<tbody>'+out.map(evRow).join('')+'</tbody></table></div>':emptyBox('Nothing lent out yet.'))+'</section>';
  var sub=(date>=today&&win.length)?'<h3 style="margin-bottom:10px">'+free.length+' of '+rs.length+' venue'+(rs.length===1?'':'s')+' free from '+first.start+' to '+last.end+' on '+fmtDate(date)+'</h3>':'';
  return head+filters+'<section>'+sub+cards+'</section>'+list;
}
function lentToPanel(){
  var u=me();if(u.role!=='hod'||!u.deptId)return '';
  var up=S.events.filter(function(e){return myDepts().indexOf(e.forDeptId)>-1&&e.date>=today}).sort(function(a,b){return a.date.localeCompare(b.date)}).slice(0,8);
  return '<section class="panel"><h3>Venues lent to your department</h3>'+(up.length?'<ul class="list">'+up.map(function(e){var r=resById(e.resId),ld=deptById(e.lentDeptId);return '<li><span><b>'+esc(e.title)+'</b><br><span class="note">'+esc(r?r.name:'Removed venue')+' · '+fmtDate(e.date)+' · <span class="mono">'+timeRange(e.slotIds)+'</span>'+(ld?' · lent by '+esc(ld.code):'')+'</span></span></li>'}).join('')+'</ul>':'<p class="note" style="margin:0">No other department has lent you a venue yet.</p>')+'</section>';
}

/* ---------- weekly tracker of academic and training hours ---------- */
function addD(s,n){var d=new Date(s+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
function mondayOf(s){var w=new Date(s+'T00:00:00Z').getUTCDay();return addD(s,-(w===0?6:w-1))}
function fmtShort(s){return new Date(s+'T00:00:00Z').toLocaleDateString('en-IN',{day:'numeric',month:'short',timeZone:'UTC'})}
function fmtLong(s){return new Date(s+'T00:00:00Z').toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'})}
var DAYS3=['Mon','Tue','Wed','Thu','Fri'];
var rnd1=function(n){return Math.round(n*10)/10};
function loadList(){return S.loads.slice().sort(function(a,b){return LOAD_KINDS.indexOf(a.kind)-LOAD_KINDS.indexOf(b.kind)||a.name.localeCompare(b.name)})}
// Saturday and Sunday are off unless converted to a working day. A section's own entry beats a campus-wide one; 'working' beats 'off' at the same level.
function dayInfo(classId,date){
  var cover=S.holidays.filter(function(h){return h.dateFrom<=date&&date<=h.dateTo&&(!h.classId||h.classId===classId)});
  for(var lv=0;lv<2;lv++){
    var L=cover.filter(function(h){return lv===0?!!h.classId:!h.classId});
    var w=L.filter(function(h){return h.kind==='working'})[0];if(w)return {off:false,title:w.title,entry:w,own:lv===0};
    var o=L[0];if(o)return {off:true,title:o.title,entry:o,own:lv===0};
  }
  var wd=new Date(date+'T00:00:00Z').getUTCDay();
  return wd===0||wd===6?{off:true,title:wd===0?'Sunday':'Saturday',weekend:true}:{off:false,title:'Working day'};
}
function offFor(classId,date){var i=dayInfo(classId,date);return i.off?i:null}
function lastWorking(classId,week){for(var i=6;i>=0;i--){var d=addD(week,i);if(!dayInfo(classId,d).off)return d}return null}
function planRow(classId,week,loadId){for(var i=0;i<S.wplans.length;i++){var r=S.wplans[i];if(r.classId===classId&&r.weekStart===week&&r.loadId===loadId)return r}return null}
function canEditTrack(classId){var u=me();if(u.role==='admin')return true;if(u.role!=='hod')return false;var c=classById(classId);return !!c&&myDepts().indexOf(c.deptId)>-1}
function sgn(n){return (n>0?'+':'−')+Math.abs(rnd1(n))}
function varCell(planned,actual,extra){
  if(actual===null||actual===undefined)return '<td class="vr-wait'+(extra||'')+'">Pending</td>';
  var d=rnd1(actual-planned);
  return d===0?'<td class="vr-ok'+(extra||'')+'">✓ On plan</td>':'<td class="vr-bad'+(extra||'')+'">'+sgn(d)+' hrs</td>';
}
function weekTotals(classId,week){
  var p=0,a=0,n=0,rows=S.wplans.filter(function(r){return r.classId===classId&&r.weekStart===week});
  rows.forEach(function(r){p+=r.planned;if(r.actual!==null&&r.actual!==undefined){a+=r.actual;n++;}});
  var diff=0;rows.forEach(function(r){if(r.actual!==null&&r.actual!==undefined)diff+=r.actual-r.planned});
  return {planned:rnd1(p),actual:rnd1(a),entered:n,diff:rnd1(diff)};
}
function cumulative(classId){
  var cut=mondayOf(today),d=0,n=0;
  S.wplans.forEach(function(r){if(r.classId===classId&&r.weekStart<=cut&&r.actual!==null&&r.actual!==undefined){d+=r.actual-r.planned;n++}});
  return {diff:rnd1(d),entered:n};
}
function vTrackPlan(){
  var u=me(),isHod=u.role==='hod';
  var head='<div class="head"><div><h2>Academic tracker</h2><p>Plan the hours of each load type for every week, then record what was actually completed. The week runs Monday to Friday. Saturday and Sunday are off unless converted to working days.</p></div></div>';
  var depts=S.depts.filter(function(d){return (!isHod||myDepts().indexOf(d.id)>-1)&&tClassesOf(d.id).length});
  if(!depts.length)return head+trNav()+emptyBox(NOMAP(u));
  var loads=loadList();
  if(!loads.length)return head+trNav()+emptyBox('No load types yet. The administrator adds them in Masters → Load types.');
  if(!ui.trDept||!depts.some(function(d){return d.id===ui.trDept}))ui.trDept=depts[0].id;
  var cls=tClassesOf(ui.trDept);
  if(!cls.length)return head+trNav()+trControls(depts,cls)+emptyBox('This department has no years or sections yet. The administrator adds them in Masters → Years & sections.');
  if(!ui.trClass||(trIsGroup(ui.trClass)?!trIds(ui.trClass).length:!cls.some(function(c){return c.id===ui.trClass})))ui.trClass=cls[0].id;
  var ws=weeksOfMonth(ui.trMonth);
  if(ws.indexOf(ui.trWeek)<0)ui.trWeek=ws.indexOf(mondayOf(today))>-1?mondayOf(today):ws[0];
  var week=ui.trWeek,ids=trIds(ui.trClass),grp=trIsGroup(ui.trClass),cid=ids[0],glabel=grp?trGroupLabel(ui.trClass):classLabel(cid),edit=ids.every(canEditTrack);
  var wkend=[5,6].filter(function(i){return !dayInfo(cid,addD(week,i)).off});
  var cellsN=5+wkend.length;
  var strip='<div class="dstrip" style="grid-template-columns:repeat('+cellsN+',minmax(0,1fr))">'+DAYS3.concat(wkend.map(function(i){return i===5?'Sat':'Sun'})).map(function(n,i){var di=i<5?i:wkend[i-5],d=addD(week,di),h=dayInfo(cid,d);return '<div class="dcell'+(h.off?' off':' work')+'" title="'+esc(h.title)+'"><b>'+n+'</b> '+fmtShort(d)+'<span>'+esc(h.off?h.title:(h.entry?h.title:'Working day'))+'</span></div>'}).join('')+'</div>';
  var working=[0,1,2,3,4,5,6].filter(function(i){return !dayInfo(cid,addD(week,i)).off}).length;
  // month plan: one box, one column pair per week
  var n=ids.length,mp={};
  function wkOpen(w){var lw=lastWorking(cid,w);return !lw||today>=lw}
  var head1='<th rowspan="2">Load type</th>'+ws.map(function(w){return '<th colspan="2" class="wkh'+(w===week?' cur':'')+'"><button class="link" data-act="trwk" data-w="'+w+'">'+fmtShort(w)+' – '+fmtShort(addD(w,4))+'</button></th>'}).join('')+'<th colspan="3" class="wkh mon">Month</th>';
  var head2=ws.map(function(w){return '<th class="sub'+(w===week?' cur':'')+'">Plan</th><th class="sub'+(w===week?' cur':'')+'">Actual</th>'}).join('')+'<th class="sub mon">Plan</th><th class="sub mon">Actual</th><th class="sub mon">vs plan</th>';
  var rows='',GP={},GA={},GD={},GN=0;
  ws.forEach(function(w){GP[w]=0;GA[w]=0;GD[w]=0});var gMP=0,gMA=0,gMD=0,gMN=0;
  LOAD_KINDS.forEach(function(kind){
    var L=loads.filter(function(l){return l.kind===kind});if(!L.length)return;
    var KP={},KA={},KD={},KN={};ws.forEach(function(w){KP[w]=0;KA[w]=0;KD[w]=0;KN[w]=0});var kMP=0,kMA=0,kMD=0,kMN=0;
    rows+='<tr class="kind"><th colspan="'+(1+ws.length*2+3)+'">'+kind+' load</th></tr>';
    L.forEach(function(l){
      var tds='',mP=0,mA=0,mD=0,mN=0;
      ws.forEach(function(w){
        var cv=cellVals(ids,w,l.id),open=wkOpen(w),cur=w===week?' cur':'';
        var psum=0,asum=0,dsum=0,anum=0;
        ids.forEach(function(id){var r=planRow(id,w,l.id),pp=r?r.planned:0,aa=r&&r.actual!==undefined&&r.actual!==null?r.actual:null;psum+=pp;if(aa!==null){asum+=aa;dsum+=aa-pp;anum++}});
        var pAvg=psum/n;mP+=pAvg;if(anum){mA+=asum/n;mD+=dsum/n;mN++}
        KP[w]+=pAvg;if(anum){KA[w]+=asum/n;KD[w]+=dsum/n;KN[w]++}
        var pc=edit?'<input class="hrs" type="number" min="0" max="100" step="0.5" inputmode="decimal" value="'+(cv.pMixed?'':(cv.p?cv.p:''))+'" placeholder="'+(cv.pMixed?'mixed':'0')+'" data-tr="'+(grp?ui.trClass:cid)+'|'+l.id+'|planned|'+w+'" aria-label="Planned hours, '+esc(l.name)+', week of '+fmtShort(w)+'">':'<span class="mono">'+(cv.pMixed?'mixed':(cv.p||'–'))+'</span>';
        var single=!grp&&cv.a!==null,tone=anum&&!cv.pMixed&&!cv.aMixed&&cv.a!==null?(rnd1(cv.a-cv.p)===0?' ok':' bad'):'';
        var ac=(edit&&!grp)?'<input class="hrs" type="number" min="0" max="100" step="0.5" inputmode="decimal" value="'+(cv.a===null?'':cv.a)+'" placeholder="'+(open?'hrs':'–')+'"'+(open?'':' disabled title="Opens on the last working day of this week"')+' data-tr="'+cid+'|'+l.id+'|actual|'+w+'" aria-label="Actual hours, '+esc(l.name)+', week of '+fmtShort(w)+'">':'<span class="mono">'+(cv.aMixed?'mixed':(cv.a===null?'–':cv.a))+'</span>';
        tds+='<td class="wp'+cur+'">'+pc+'</td><td class="wa'+tone+cur+'">'+ac+(tone?'<small class="vb">'+(tone===' ok'?'✓':sgn(cv.a-cv.p))+'</small>':'')+'</td>';
      });
      kMP+=mP;kMA+=mA;kMD+=mD;kMN+=mN;
      rows+='<tr><td>'+esc(l.name)+'</td>'+tds+'<td class="mono mon">'+rnd1(mP)+'</td><td class="mono mon">'+(mN?rnd1(mA):'–')+'</td>'+varCell(0,mN?rnd1(mD):null,' mon')+'</tr>';
    });
    var kt='';ws.forEach(function(w){var has=KN[w]>0,tone=has?(rnd1(KD[w])===0?' ok':' bad'):'';kt+='<td class="mono wp">'+rnd1(KP[w])+'</td><td class="mono wa'+tone+'">'+(has?rnd1(KA[w]):'–')+(has?'<small class="vb">'+(tone===' ok'?'✓':sgn(KD[w]))+'</small>':'')+'</td>';GP[w]+=KP[w];GA[w]+=KA[w];GD[w]+=KD[w];if(has)GN++});
    rows+='<tr class="sub"><td>'+kind+' total</td>'+kt+'<td class="mono mon">'+rnd1(kMP)+'</td><td class="mono mon">'+(kMN?rnd1(kMA):'–')+'</td>'+varCell(0,kMN?rnd1(kMD):null,' mon')+'</tr>';
    gMP+=kMP;gMA+=kMA;gMD+=kMD;gMN+=kMN;
  });
  var gt='';ws.forEach(function(w){var has=false;S.wplans.forEach(function(r){if(ids.indexOf(r.classId)>-1&&r.weekStart===w&&r.actual!==undefined&&r.actual!==null)has=true});var tone=has?(rnd1(GD[w])===0?' ok':' bad'):'';gt+='<td class="mono wp">'+rnd1(GP[w])+'</td><td class="mono wa'+tone+'">'+(has?rnd1(GA[w]):'–')+(has?'<small class="vb">'+(tone===' ok'?'✓':sgn(GD[w]))+'</small>':'')+'</td>'});
  rows+='<tr class="grand"><td>All load types</td>'+gt+'<td class="mono mon">'+rnd1(gMP)+'</td><td class="mono mon">'+(gMN?rnd1(gMA):'–')+'</td>'+varCell(0,gMN?rnd1(gMD):null,' mon')+'</tr>';
  var lw=lastWorking(cid,week),open=wkOpen(week);
  var note=grp?'Figures are the average per section. Hours you type under Plan are applied to every section in this group. Pick a single section to enter actual hours.':(edit?(open?'Enter what was actually completed in the week that has ended or is ending.':'Planned hours can be entered any time. Actual hours open on the last working day of each week.'):'You can view this plan. Only the department head or an administrator can change it.');
  var table='<div class="scroll"><table class="tbl trtbl trmonth"><thead><tr>'+head1+'</tr><tr>'+head2+'</tr></thead><tbody>'+rows+'</tbody></table></div><p class="note" style="margin:6px 0 0">'+note+' Green means the target was met exactly. Red shows how many hours over (+) or under (−) the plan.</p>';
  var sum=cls.map(function(c){
    var t=weekTotals(c.id,week),cu=cumulative(c.id);
    return '<tr'+(ids.indexOf(c.id)>-1?' class="cur"':'')+'><td><button class="link" data-act="trclass" data-id="'+c.id+'"><b>Year '+c.year+' · '+esc(c.section)+'</b></button></td><td class="mono">'+t.planned+'</td><td class="mono">'+(t.entered?t.actual:'–')+'</td>'+varCell(0,t.entered?t.diff:null)+varCell(0,cu.entered?cu.diff:null)+'</tr>';
  }).join('');
  var summary='<section><h3 style="margin-bottom:10px">All sections of '+esc(deptById(ui.trDept).code)+', week of '+fmtShort(week)+'</h3><div class="scroll"><table class="tbl trtbl"><thead><tr><th>Section</th><th>Planned (hrs)</th><th>Actual (hrs)</th><th>This week vs plan</th><th>Overall to date vs plan</th></tr></thead><tbody>'+sum+'</tbody></table></div></section>';
  var offs=S.holidays.filter(function(h){return (!h.classId||(classById(h.classId)&&classById(h.classId).deptId===ui.trDept))&&h.dateTo>=addD(today,-60)}).sort(function(a,b){return b.dateFrom.localeCompare(a.dateFrom)}).slice(0,15);
  var offTbl='<section><div class="rowhead"><h3>Off days and working days</h3>'+((isHod||u.role==='admin')?'<button class="btn sm" data-act="add" data-t="offday">Mark off or working day</button>':'')+'</div>'+trCalendar(cid,edit||u.role==='admin',glabel)+(offs.length?'<div class="scroll"><table class="tbl"><thead><tr><th>Dates</th><th>Type</th><th>Title</th><th>Applies to</th><th></th></tr></thead><tbody>'+offs.map(function(h){var k='off:'+h.id,own=h.classId?canEditTrack(h.classId):u.role==='admin';return '<tr><td class="mono" style="white-space:nowrap">'+(h.dateFrom===h.dateTo?fmtLong(h.dateFrom):fmtShort(h.dateFrom)+' – '+fmtLong(h.dateTo))+'</td><td>'+kindTag(h)+'</td><td>'+esc(h.title)+'</td><td>'+(h.classId?esc(classLabel(h.classId)):'<span class="dtag central">All departments</span>')+'</td><td class="act">'+(own?'<button class="btn sm danger" data-act="del" data-k="'+k+'">'+(ui.confirm===k?'Confirm delete':'Delete')+'</button>':'')+'</td></tr>'}).join('')+'</tbody></table></div>':emptyBox('No off days in the last two months or ahead.'))+'<p class="note" style="margin:6px 0 0">Saturdays and Sundays are off without any entry. To work on one, choose “Working day” when marking, or click the date in the calendar. The administrator sets days for everyone. Department heads set them for their own years and sections.</p></section>';
  var monthLabel=new Date(ui.trMonth+'-01T00:00:00Z').toLocaleDateString('en-IN',{month:'long',year:'numeric',timeZone:'UTC'});
  var wk='<div class="panel"><div class="filters">'+trControlsHTML(depts,cls,ws)+'<button class="btn sm" data-act="trthis">This week</button></div>'+(edit&&!grp?'<div class="filters copyrow"><label>Copy this week’s planned hours to'+scopeHTML('D:'+ui.trDept,true,'tr-copy')+'</label><button class="btn sm" data-act="trcopy">Copy plan</button><span class="note">Copies the plan of '+esc(glabel)+' for '+fmtShort(week)+' – '+fmtShort(addD(week,4))+'. Actual hours are never copied.</span></div>':'')+'</div>';
  return head+trNav()+wk+'<section><h3 style="margin-bottom:10px">'+esc(glabel)+' · '+fmtShort(week)+' – '+fmtLong(addD(week,4))+' <span class="note">· '+working+' working day'+(working===1?'':'s')+'</span></h3>'+strip+'</section><section><h3 style="margin-bottom:10px">Plan for '+monthLabel+'</h3>'+table+'</section>'+summary+offTbl;
}

function vTrack(){return ui.trView==='report'?vTrackReport():ui.trView==='board'?vTrackBoard():vTrackPlan()}
function NOMAP(u){return u.role==='admin'?'No department is mapped to the Academic tracker yet. Choose the departments, years and sections in Masters → Tracker mapping.':(u.role==='hod'&&!myDepts().length?'No department is linked to this account. Ask the administrator to set it in Masters → Users.':'No department is mapped to the Academic tracker yet. The administrator maps departments, years and sections in Masters → Tracker mapping.')}
function trNav(){
  return '<div class="seg trnav" role="tablist" aria-label="Tracker views">'+[['plan','Weekly plan'],['report','Progress report'],['board','Leaderboard']].map(function(v){return '<button class="btn'+(ui.trView===v[0]?' on':'')+'" role="tab" aria-selected="'+(ui.trView===v[0])+'" data-act="trview" data-v="'+v[0]+'">'+v[1]+'</button>'}).join('')+'</div>';
}
function pct(x){return x===null||x===undefined?'–':Math.round(x*100)+'%'}
function tone(x){return x===null?'':x>=0.95?'ok':x>=0.8?'mid':'bad'}
function meter(x){return '<span class="meter"><i class="'+tone(x)+'" style="width:'+(x===null?0:Math.round(x*100))+'%"></i></span>'}
function trIndex(){var m={};S.wplans.forEach(function(r){(m[r.classId]||(m[r.classId]=[])).push(r)});return m}
function periodWeeks(per){
  var cur=mondayOf(today);
  if(per&&per!=='all')return weeksOfMonth(per).filter(function(w){return w<=cur});
  var seen={};S.wplans.forEach(function(r){if(r.weekStart<=cur)seen[r.weekStart]=1});return Object.keys(seen).sort();
}
function trStats(cids,W,kind,idx){
  var ws={};W.forEach(function(w){ws[w]=1});
  var okLoad={};S.loads.forEach(function(l){if(!kind||l.kind===kind)okLoad[l.id]=1});
  var o={planned:0,actual:0,pp:0,abs:0,diff:0,closed:0,reported:0,byLoad:{},byWeek:{}};
  cids.forEach(function(cid){
    var per={};
    (idx[cid]||[]).forEach(function(r){
      if(!ws[r.weekStart]||!okLoad[r.loadId])return;
      var w=per[r.weekStart]||(per[r.weekStart]={p:0,rep:false});w.p+=r.planned;o.planned+=r.planned;
      var bw=o.byWeek[r.weekStart]||(o.byWeek[r.weekStart]={p:0,a:0,pp:0,abs:0});bw.p+=r.planned;
      var bl=o.byLoad[r.loadId]||(o.byLoad[r.loadId]={p:0,a:0,pp:0,abs:0});
      if(r.actual!==null&&r.actual!==undefined){
        w.rep=true;var d=r.actual-r.planned;
        o.actual+=r.actual;o.pp+=r.planned;o.abs+=Math.abs(d);o.diff+=d;
        bw.a+=r.actual;bw.pp+=r.planned;bw.abs+=Math.abs(d);bl.a+=r.actual;bl.pp+=r.planned;bl.abs+=Math.abs(d);
      }
    });
    Object.keys(per).forEach(function(w){var lw=lastWorking(cid,w);if(per[w].p>0&&lw&&lw<today){o.closed++;if(per[w].rep)o.reported++}});
  });
  o.adh=o.pp>0?Math.max(0,1-o.abs/o.pp):null;
  o.rep=o.closed>0?o.reported/o.closed:null;
  o.score=(o.adh===null&&o.rep===null)?null:(o.adh===null?o.rep:(o.rep===null?o.adh:0.7*o.adh+0.3*o.rep));
  return o;
}
function periodSel(){
  var mo=monthOptions().filter(function(m){return m<=today.slice(0,7)});
  return '<label>Period<select data-set="rpPeriod"><option value="all"'+(ui.rpPeriod==='all'?' selected':'')+'>All weeks to date</option>'+mo.slice().reverse().map(function(m){return '<option value="'+m+'"'+(ui.rpPeriod===m?' selected':'')+'>'+new Date(m+'-01T00:00:00Z').toLocaleDateString('en-IN',{month:'long',year:'numeric',timeZone:'UTC'})+'</option>'}).join('')+'</select></label>'+
    '<label>Hours<select data-set="rpKind"><option value="">Academic and training</option>'+LOAD_KINDS.map(function(k){return '<option value="'+k+'"'+(ui.rpKind===k?' selected':'')+'>'+k+' only</option>'}).join('')+'</select></label>';
}
function periodName(){return ui.rpPeriod==='all'?'all weeks to date':new Date(ui.rpPeriod+'-01T00:00:00Z').toLocaleDateString('en-IN',{month:'long',year:'numeric',timeZone:'UTC'})}
function vTrackReport(){
  var head='<div class="head"><div><h2>Academic tracker</h2><p>How planned hours compare with completed hours, by section, load type and week.</p></div></div>';
  var depts=S.depts.filter(function(d){return tClassesOf(d.id).length});
  if(!depts.length)return head+trNav()+emptyBox(NOMAP(me()));
  if(!ui.rpDept||!depts.some(function(d){return d.id===ui.rpDept}))ui.rpDept=(depts.filter(function(d){return myDepts().indexOf(d.id)>-1})[0]||depts[0]).id;
  var d=deptById(ui.rpDept),cls=tClassesOf(d.id),idx=trIndex(),W=periodWeeks(ui.rpPeriod),K=ui.rpKind;
  var T=trStats(cls.map(function(c){return c.id}),W,K,idx);
  var ctl='<div class="panel"><div class="filters"><label>Department<select data-set="rpDept">'+depts.map(function(x){return '<option value="'+x.id+'"'+(x.id===d.id?' selected':'')+'>'+esc(x.code+' – '+x.name)+'</option>'}).join('')+'</select></label>'+periodSel()+'<button class="btn sm" data-act="rpcsv">Download CSV</button><button class="btn sm" data-act="rpprint">Print</button></div></div>';
  if(!W.length||!T.planned)return head+trNav()+ctl+emptyBox('No hours were planned for '+esc(d.code)+' in '+periodName()+'. Plans appear here once department heads enter them in the Weekly plan.');
  var net=rnd1(T.diff);
  var tiles='<div class="strip trtiles"><div><b>'+rnd1(T.planned)+'</b><span>Hours planned</span></div><div><b>'+rnd1(T.actual)+'</b><span>Hours completed</span></div><div><b class="'+tone(T.adh)+'">'+pct(T.adh)+'</b><span>Plan adherence</span></div><div><b>'+T.reported+'/'+T.closed+'</b><span>Weeks reported</span></div><div><b class="'+(net===0?'ok':'bad')+'">'+(T.pp?(net===0?'On plan':sgn(net)):'–')+'</b><span>Net against plan, hrs</span></div></div>';
  var sec=cls.map(function(c){var s2=trStats([c.id],W,K,idx);return {c:c,s:s2}});
  var secRows=sec.map(function(x){var s2=x.s,df=rnd1(s2.diff);return '<tr><td><b>Year '+x.c.year+' · '+esc(x.c.section)+'</b></td><td class="mono">'+rnd1(s2.planned)+'</td><td class="mono">'+(s2.pp?rnd1(s2.actual):'–')+'</td>'+(s2.pp?(df===0?'<td class="vr-ok">✓ On plan</td>':'<td class="vr-bad">'+sgn(df)+' hrs</td>'):'<td class="vr-wait">Pending</td>')+'<td>'+meter(s2.adh)+' <span class="mono">'+pct(s2.adh)+'</span></td><td class="mono">'+s2.reported+'/'+s2.closed+'</td></tr>'}).join('');
  var secTbl='<section><h3 style="margin-bottom:10px">By year and section</h3><div class="scroll"><table class="tbl trtbl"><thead><tr><th>Section</th><th>Planned (hrs)</th><th>Completed (hrs)</th><th>Against plan</th><th>Adherence</th><th>Weeks reported</th></tr></thead><tbody>'+secRows+'</tbody></table></div></section>';
  var ld=loadList().filter(function(l){return !K||l.kind===K}).map(function(l){var b=T.byLoad[l.id];if(!b)return '';var df=rnd1(b.a-b.pp),ad=b.pp>0?Math.max(0,1-b.abs/b.pp):null;return '<tr><td>'+esc(l.name)+' <span class="note">'+l.kind+'</span></td><td class="mono">'+rnd1(b.pp)+'</td><td class="mono">'+rnd1(b.a)+'</td>'+(b.pp?(df===0?'<td class="vr-ok">✓ On plan</td>':'<td class="vr-bad">'+sgn(df)+' hrs</td>'):'<td class="vr-wait">–</td>')+'<td>'+meter(ad)+' <span class="mono">'+pct(ad)+'</span></td></tr>'}).join('');
  var ldTbl='<section><h3 style="margin-bottom:10px">By load type</h3><div class="scroll"><table class="tbl trtbl"><thead><tr><th>Load type</th><th>Planned in reported weeks</th><th>Completed</th><th>Against plan</th><th>Adherence</th></tr></thead><tbody>'+ld+'</tbody></table></div></section>';
  var wk=Object.keys(T.byWeek).sort().slice(-10),mx=1;wk.forEach(function(w){mx=Math.max(mx,T.byWeek[w].p,T.byWeek[w].a)});
  var trend='<section><h3 style="margin-bottom:10px">Week by week</h3><div class="panel"><div class="trend">'+wk.map(function(w){var b=T.byWeek[w],ad=b.pp>0?Math.max(0,1-b.abs/b.pp):null;return '<div class="tcol" title="Week of '+fmtLong(w)+': planned '+rnd1(b.p)+', completed '+(b.pp?rnd1(b.a):'not yet')+'"><div class="bars"><i class="bp" style="height:'+Math.round(b.p/mx*100)+'%"></i><i class="ba '+(b.pp?tone(ad):'')+'" style="height:'+(b.pp?Math.round(b.a/mx*100):0)+'%"></i></div><small>'+fmtShort(w)+'</small><small class="mono">'+(b.pp?pct(ad):'–')+'</small></div>'}).join('')+'</div><p class="note" style="margin:8px 0 0"><span class="lg wk"></span>Planned <span class="lg work"></span>Completed, coloured by how close it came to plan. Hours are summed across all sections of '+esc(d.code)+'.</p></div></section>';
  return head+trNav()+ctl+'<h3 class="repttl">'+esc(d.name)+' · '+periodName()+(K?' · '+K+' hours':'')+'</h3>'+tiles+secTbl+ldTbl+trend+'<p class="note">Plan adherence is the share of planned hours that were delivered exactly: hours over or under the plan both count against it. Weeks reported counts finished weeks that have actual hours entered.</p>';
}
function vTrackBoard(){
  var head='<div class="head"><div><h2>Academic tracker</h2><p>Departments ranked on how closely they deliver planned hours, and how reliably they report them. Everyone can see every department.</p></div></div>';
  var depts=S.depts.filter(function(d){return tClassesOf(d.id).length});
  if(!depts.length)return head+trNav()+emptyBox(NOMAP(me()));
  var idx=trIndex(),W=periodWeeks(ui.rpPeriod),K=ui.rpKind,mine=myDepts();
  var ctl='<div class="panel"><div class="filters">'+periodSel()+'<span class="note" style="align-self:center;max-width:60ch">Score = 70% plan adherence + 30% weeks reported. Only weeks with planned hours count.</span></div></div>';
  var rows=depts.map(function(d){var cids=tClassesOf(d.id).map(function(c){return c.id});return {d:d,s:trStats(cids,W,K,idx),n:cids.length}});
  var ranked=rows.filter(function(r){return r.s.score!==null}).sort(function(a,b){return b.s.score-a.s.score||b.s.adh-a.s.adh});
  var unranked=rows.filter(function(r){return r.s.score===null});
  if(!ranked.length)return head+trNav()+ctl+emptyBox('No hours have been planned and reported for '+periodName()+' yet. The board fills in once department heads enter plans and actual hours.');
  var lead=ranked[0];
  var banner='<div class="leadband"><div class="trophy" aria-hidden="true">★</div><div><b>'+esc(lead.d.name)+'</b> leads '+(K?K.toLowerCase()+' hours':'the campus')+' for '+periodName()+' with a score of <b>'+pct(lead.s.score)+'</b>.</div></div>';
  var tbl='<div class="scroll"><table class="tbl trtbl board"><thead><tr><th>Rank</th><th>Department</th><th>Score</th><th>Plan adherence</th><th>Weeks reported</th><th>Net hours against plan</th><th>Sections</th></tr></thead><tbody>'+ranked.map(function(r,i){var own=mine.indexOf(r.d.id)>-1,df=rnd1(r.s.diff);return '<tr'+(own?' class="mine"':'')+'><td><span class="rk r'+(i<3?i+1:0)+'">'+(i+1)+'</span></td><td><b>'+esc(r.d.name)+'</b> <span class="tcode">'+esc(r.d.code)+'</span>'+(own?' <span class="badge b-ok">Your department</span>':'')+'</td><td class="score mono">'+pct(r.s.score)+'</td><td>'+meter(r.s.adh)+' <span class="mono">'+pct(r.s.adh)+'</span></td><td class="mono">'+(r.s.closed?r.s.reported+'/'+r.s.closed+' · '+pct(r.s.rep):'–')+'</td>'+(r.s.pp?(df===0?'<td class="vr-ok">✓ On plan</td>':'<td class="vr-bad">'+sgn(df)+' hrs</td>'):'<td class="vr-wait">–</td>')+'<td class="mono">'+r.n+'</td></tr>'}).join('')+'</tbody></table></div>';
  var un=unranked.length?'<p class="note">Not ranked yet, nothing planned for this period: '+unranked.map(function(r){return esc(r.d.code)}).join(', ')+'.</p>':'';
  var all=[];depts.forEach(function(d){tClassesOf(d.id).forEach(function(c){var s2=trStats([c.id],W,K,idx);if(s2.score!==null)all.push({d:d,c:c,s:s2})})});
  all.sort(function(a,b){return b.s.score-a.s.score||b.s.adh-a.s.adh});
  var top=all.slice(0,10),secTbl=top.length?'<section><h3 style="margin-bottom:10px">Top sections</h3><div class="scroll"><table class="tbl trtbl board"><thead><tr><th>Rank</th><th>Section</th><th>Score</th><th>Plan adherence</th><th>Weeks reported</th></tr></thead><tbody>'+top.map(function(r,i){var own=mine.indexOf(r.d.id)>-1;return '<tr'+(own?' class="mine"':'')+'><td><span class="rk r'+(i<3?i+1:0)+'">'+(i+1)+'</span></td><td><b>'+esc(r.d.code)+' · Year '+r.c.year+' '+esc(r.c.section)+'</b></td><td class="score mono">'+pct(r.s.score)+'</td><td>'+meter(r.s.adh)+' <span class="mono">'+pct(r.s.adh)+'</span></td><td class="mono">'+(r.s.closed?r.s.reported+'/'+r.s.closed:'–')+'</td></tr>'}).join('')+'</tbody></table></div></section>':'';
  return head+trNav()+ctl+banner+tbl+un+secTbl;
}
function rpCsv(){
  var d=deptById(ui.rpDept),idx=trIndex(),W=periodWeeks(ui.rpPeriod),K=ui.rpKind;
  var q=function(v){v=String(v);return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
  var out=[['Department','Year','Section','Planned hrs','Completed hrs','Net vs plan hrs','Adherence %','Weeks reported','Weeks closed'].join(',')];
  tClassesOf(d.id).forEach(function(c){var t=trStats([c.id],W,K,idx);out.push([d.code,c.year,c.section,rnd1(t.planned),t.pp?rnd1(t.actual):'',t.pp?rnd1(t.diff):'',t.adh===null?'':Math.round(t.adh*100),t.reported,t.closed].map(q).join(','))});
  var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([out.join('\n')],{type:'text/csv'}));a.download='academic-progress-'+d.code+'-'+ui.rpPeriod+'.csv';document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},500);
}
function kindTag(h){return h.kind==='working'?'<span class="dtag work">Working day</span>':'<span class="dtag">Off day</span>'}
function trCalendar(cid,canMark,lab){
  var m=ui.trMonth,first=m+'-01',start=mondayOf(first),y=+m.slice(0,4),mo=+m.slice(5,7),last=new Date(Date.UTC(y,mo,0)).toISOString().slice(0,10);
  var title=new Date(first+'T00:00:00Z').toLocaleDateString('en-IN',{month:'long',year:'numeric',timeZone:'UTC'});
  var cells='',d=start;
  while(d<=last||new Date(d+'T00:00:00Z').getUTCDay()!==1){
    var inM=d.slice(0,7)===m,i=dayInfo(cid,d),cls2='cal '+(i.off?(i.weekend?'weekend':(i.own?'off own':'off')):(i.entry?'wk':'work'))+(inM?'':' out')+(d===today?' today':''),lab=i.weekend?'':i.title;
    cells+='<'+(canMark&&inM?'button':'div')+' class="'+cls2+'"'+(canMark&&inM?' data-act="calday" data-d="'+d+'" data-off="'+(i.off?1:0)+'"':'')+' title="'+esc(i.title)+'"><b>'+(+d.slice(8))+'</b><span>'+esc(lab)+'</span></'+(canMark&&inM?'button':'div')+'>';
    d=addD(d,1);if(d>last&&new Date(d+'T00:00:00Z').getUTCDay()===1)break;
  }
  var hd=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(function(n){return '<div class="calh">'+n+'</div>'}).join('');
  return '<div class="calbox"><div class="rowhead"><b>'+title+' · '+esc(lab||classLabel(cid))+'</b><span class="seg"><button class="btn sm" data-act="trmonth" data-n="-1">Previous</button><button class="btn sm" data-act="trmonth" data-n="0">This month</button><button class="btn sm" data-act="trmonth" data-n="1">Next</button></span></div><div class="calgrid">'+hd+cells+'</div><p class="note" style="margin:6px 0 0"><span class="lg work"></span>Working <span class="lg off"></span>Off day <span class="lg weekend"></span>Weekend <span class="lg wk"></span>Converted to working'+(canMark?'. Click a date to mark it off, or to make an off day a working day.':'.')+'</p></div>';
}
function trIsGroup(sel){return sel==='ALL'||(typeof sel==='string'&&sel.indexOf('Y:')===0)}
function trIds(sel){var cl=tClassesOf(ui.trDept);if(sel==='ALL')return cl.map(function(c){return c.id});if(trIsGroup(sel)){var y=+sel.slice(2);return cl.filter(function(c){return c.year===y}).map(function(c){return c.id})}return [sel]}
function trScope(sel){return sel==='ALL'?'D:'+ui.trDept:trIsGroup(sel)?'Y:'+ui.trDept+':'+sel.slice(2):sel}
function trGroupLabel(sel){var d=deptById(ui.trDept);return sel==='ALL'?'All years and sections of '+(d?d.code:''):'Year '+sel.slice(2)+' · all sections'}
function weeksOfMonth(m){var first=m+'-01',last=new Date(Date.UTC(+m.slice(0,4),+m.slice(5,7),0)).toISOString().slice(0,10),r=[];for(var w=mondayOf(first);w<=last;w=addD(w,7)){if(addD(w,4)>=first)r.push(w)}return r}
function cellVals(ids,week,loadId){
  var ps=[],as=[];
  ids.forEach(function(id){var r=planRow(id,week,loadId);ps.push(r?r.planned:0);as.push(r&&r.actual!==undefined&&r.actual!==null?r.actual:null)});
  var pc=ps.every(function(x){return x===ps[0]}),ac=as.every(function(x){return x===as[0]});
  return {p:pc?ps[0]:null,a:ac?as[0]:null,pMixed:!pc,aMixed:!ac};
}
function monthOptions(){
  var r=[],b=new Date(today.slice(0,7)+'-01T00:00:00Z');
  for(var k=-6;k<=12;k++){var d=new Date(Date.UTC(b.getUTCFullYear(),b.getUTCMonth()+k,1)),v=d.toISOString().slice(0,7);r.push(v)}
  if(r.indexOf(ui.trMonth)<0){r.push(ui.trMonth);r.sort()}
  return r;
}
function trControlsHTML(depts,cls,ws){
  var years=yearsOf(cls),mo=monthOptions();
  return (depts.length>1?'<label>Department<select id="tr-dept" data-set="trDept">'+depts.map(function(d){return '<option value="'+d.id+'"'+(d.id===ui.trDept?' selected':'')+'>'+esc(d.code+' – '+d.name)+'</option>'}).join('')+'</select></label>':'')+
    '<label>Year and section<select id="tr-class" data-set="trClass"><optgroup label="Whole groups"><option value="ALL"'+(ui.trClass==='ALL'?' selected':'')+'>All years and sections</option>'+years.map(function(y){return '<option value="Y:'+y+'"'+(ui.trClass==='Y:'+y?' selected':'')+'>Year '+y+' · all sections</option>'}).join('')+'</optgroup><optgroup label="One section">'+cls.map(function(c){return '<option value="'+c.id+'"'+(c.id===ui.trClass?' selected':'')+'>Year '+c.year+' · Section '+esc(c.section)+'</option>'}).join('')+'</optgroup></select></label>'+
    (ws?'<label>Month<select id="tr-month" data-set="trMonth">'+mo.map(function(m){return '<option value="'+m+'"'+(m===ui.trMonth?' selected':'')+'>'+new Date(m+'-01T00:00:00Z').toLocaleDateString('en-IN',{month:'long',year:'numeric',timeZone:'UTC'})+'</option>'}).join('')+'</select></label>'+
    '<label>Week<select id="tr-week" data-set="trWeek">'+ws.map(function(w,i){return '<option value="'+w+'"'+(w===ui.trWeek?' selected':'')+'>Week '+(i+1)+' · '+fmtShort(w)+' to '+fmtShort(addD(w,4))+'</option>'}).join('')+'</select></label>':'');
}
function trControls(depts,cls){return '<div class="panel"><div class="filters">'+trControlsHTML(depts,cls)+'</div></div>'}
function mTrack(){
  var rows=S.depts.map(function(d){
    var cl=classesOf(d.id);if(!cl.length)return '';
    var on=cl.filter(function(c){return c.tracked}).length;
    return '<tr><td><label class="chk"><input type="checkbox" data-trk="d:'+d.id+'"'+(on===cl.length?' checked':'')+'> <b>'+esc(d.name)+'</b> <span class="tcode">'+esc(d.code)+'</span></label><div class="note">'+(on?on+' of '+cl.length+' sections in the tracker':'Not in the tracker')+'</div></td><td>'+yearsOf(cl).map(function(y){return '<div class="yrow"><span class="yl">Year '+y+'</span>'+cl.filter(function(c){return c.year===y}).map(function(c){return '<label class="chip'+(c.tracked?' on':'')+'"><input type="checkbox" data-trk="c:'+c.id+'"'+(c.tracked?' checked':'')+'> '+esc(c.section)+'</label>'}).join('')+'</div>'}).join('')+'</td></tr>';
  }).join('');
  return '<div class="scroll"><table class="tbl"><thead><tr><th>Department</th><th>Years and sections shown in the Academic tracker</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+(S.classes.length?'':noMatch(0,'Add years and sections first in Masters → Years & sections.'));
}
function mLoads(){
  var L=loadList().filter(function(l){return hit(mfv('loads','q'),[l.name,l.kind])&&(!mfv('loads','kind')||l.kind===mfv('loads','kind'))});
  return mfBar('loads',[mfTxt('loads','Search','Load type name'),mfSel('loads','kind','Kind',LOAD_KINDS.map(function(k){return [k,k]}))],L.length,S.loads.length)+'<div class="scroll"><table class="tbl"><thead><tr><th>Load type</th><th>Kind</th><th>Weekly plans using it</th><th></th></tr></thead><tbody>'+
  L.map(function(l){var k='load:'+l.id;return '<tr><td><b>'+esc(l.name)+'</b></td><td><span class="badge '+(l.kind==='Academic'?'b-ok':'b-wait')+'">'+l.kind+'</span></td><td class="mono">'+S.wplans.filter(function(r){return r.loadId===l.id}).length+'</td><td class="act"><button class="btn sm" data-act="edit" data-t="load" data-id="'+l.id+'">Edit</button><button class="btn sm danger" data-act="del" data-k="'+k+'">'+(ui.confirm===k?'Confirm delete':'Delete')+'</button></td></tr>'}).join('')+'</tbody></table></div>'+(L.length?'':noMatch(S.loads.length,'No load types yet. Add theory, lab, aptitude training and so on.'));
}
function mOffdays(){
  var L=S.holidays.slice().sort(function(a,b){return b.dateFrom.localeCompare(a.dateFrom)}).filter(function(h){return hit(mfv('offdays','q'),[h.title,h.classId?classLabel(h.classId):'all departments',h.by||''])&&(!mfv('offdays','scope')||(mfv('offdays','scope')==='all'?!h.classId:!!h.classId))});
  return mfBar('offdays',[mfTxt('offdays','Search','Title or section'),mfSel('offdays','scope','Applies to',[['all','Whole campus'],['class','A year and section']])],L.length,S.holidays.length)+'<div class="scroll"><table class="tbl"><thead><tr><th>Dates</th><th>Days</th><th>Type</th><th>Title</th><th>Applies to</th><th>Added by</th><th></th></tr></thead><tbody>'+
  L.map(function(h){var k='off:'+h.id,n=Math.round((Date.parse(h.dateTo)-Date.parse(h.dateFrom))/864e5)+1;return '<tr><td class="mono" style="white-space:nowrap">'+(h.dateFrom===h.dateTo?fmtLong(h.dateFrom):fmtShort(h.dateFrom)+' – '+fmtLong(h.dateTo))+'</td><td class="mono">'+n+'</td><td>'+kindTag(h)+'</td><td><b>'+esc(h.title)+'</b></td><td>'+(h.classId?esc(classLabel(h.classId)):'<span class="dtag central">All departments</span>')+'</td><td class="note">'+esc(h.by||'')+'</td><td class="act"><button class="btn sm" data-act="edit" data-t="offday" data-id="'+h.id+'">Edit</button><button class="btn sm danger" data-act="del" data-k="'+k+'">'+(ui.confirm===k?'Confirm delete':'Delete')+'</button></td></tr>'}).join('')+'</tbody></table></div>'+(L.length?'':noMatch(S.holidays.length,'No off days yet. Add central holidays such as Gandhi Jayanti, with a date range for more than one day.'));
}
function yearsOf(cl){var r=[];cl.forEach(function(c){if(r.indexOf(c.year)<0)r.push(c.year)});return r.sort(function(a,b){return a-b})}
function scopeIds(sc){
  if(sc===''||sc==null)return [null];
  if(sc.indexOf('D:')===0)return tClassesOf(sc.slice(2)).map(function(c){return c.id});
  if(sc.indexOf('Y:')===0){var pp=sc.split(':');return tClassesOf(pp[1]).filter(function(c){return c.year===+pp[2]}).map(function(c){return c.id})}
  return [sc];
}
function scopeHTML(val,noCampus,id){
  var u=me(),admin=u.role==='admin',o='';
  if(admin&&!noCampus)o+='<option value=""'+(val===''?' selected':'')+'>All departments (whole campus)</option>';
  var ds=S.depts.filter(function(d){return admin||myDepts().indexOf(d.id)>-1});
  ds.forEach(function(d){var cl=tClassesOf(d.id);if(!cl.length)return;
    o+='<optgroup label="'+esc(d.code+' – '+d.name)+'"><option value="D:'+d.id+'"'+(val==='D:'+d.id?' selected':'')+'>All years and sections of '+esc(d.code)+'</option>'+yearsOf(cl).map(function(yr){return '<option value="Y:'+d.id+':'+yr+'"'+(val==='Y:'+d.id+':'+yr?' selected':'')+'>Year '+yr+' · all sections</option>'}).join('')+cl.map(function(c){return '<option value="'+c.id+'"'+(val===c.id?' selected':'')+'>Year '+c.year+' · Section '+esc(c.section)+'</option>'}).join('')+'</optgroup>'});
  return '<select id="'+(id||'f-scope')+'" name="scope">'+o+'</select>';
}

function vEvents(){

  var upc=S.events.filter(function(e){return e.date>=today}).sort(function(a,b){return a.date.localeCompare(b.date)});
  var past=S.events.filter(function(e){return e.date<today}).sort(function(a,b){return b.date.localeCompare(a.date)});
  var th='<thead><tr><th>Date</th><th>Time</th><th>Venue</th><th>Event</th><th>Requested by</th><th>Status</th><th></th></tr></thead>';
  return '<div class="head"><div><h2>Events</h2><p>'+(canApprove()?'Approve or decline requests. Pending requests already hold their slots.':'Events booked across campus. Requests from stakeholders are confirmed by the head of institute.')+'</p></div></div>'+
    '<section><h3 style="margin-bottom:10px">Upcoming</h3>'+(upc.length?'<div class="scroll"><table class="tbl">'+th+'<tbody>'+upc.map(evRow).join('')+'</tbody></table></div>':emptyBox('No upcoming events. Find a free venue in '+(canBook()?'Availability':'the Availability tab')+'.'))+'</section>'+
    (past.length?'<section><button class="btn sm" data-act="togglePast">'+(ui.evShowPast?'Hide':'Show')+' '+past.length+' past event'+(past.length>1?'s':'')+'</button>'+(ui.evShowPast?'<div class="scroll" style="margin-top:10px"><table class="tbl">'+th+'<tbody>'+past.map(evRow).join('')+'</tbody></table></div>':'')+'</section>':'');
}

function vTimetable(){
  var u=me(),sl=slotList();
  var deptId=u.role==='admin'?ui.ttDept:hodDept(ui.ttDept);
  var d=deptById(deptId);
  var head='<div class="head"><div><h2>'+(u.role==='admin'?'Department timetables':'Timetable · '+(d?esc(d.name):''))+'</h2><p>Click a cell to add or edit a class. The system blocks a second class for the same venue, faculty member or section in one period.</p></div>'+
    ((u.role==='admin'||myDepts().length>1)?'<label class="fld" style="min-width:240px">Department<select id="tt-dept" data-set="ttDept">'+deptOpts().filter(function(o){return u.role==='admin'||myDepts().indexOf(o[0])>-1}).map(function(o){return '<option value="'+o[0]+'"'+(o[0]===deptId?' selected':'')+'>'+esc(o[1])+'</option>'}).join('')+'</select></label>':'')+'</div>';
  if(!d)return head+emptyBox('No department is linked to this account. Ask the administrator to set it in Masters → Users.');
  var rs=S.resources.filter(function(r){return r.deptId===d.id});
  if(!rs.length)return head+emptyBox(esc(d.code)+' has no venues yet. The administrator can allocate lecture theatres and labs in Masters → Allocation.');
  if(!ui.ttRes||rs.every(function(r){return r.id!==ui.ttRes}))ui.ttRes=rs[0].id;
  if(!sl.length)return head+emptyBox('No time slots are defined yet.');
  var modes='<div class="seg"><button class="btn sm'+(ui.ttMode==='week'?' on':'')+'" data-act="mode" data-v="week">Weekly, one venue</button><button class="btn sm'+(ui.ttMode==='day'?' on':'')+'" data-act="mode" data-v="day">Daily, all venues</button></div> <button class="btn primary sm" data-act="fullday">Allot a full day</button> <button class="btn sm" data-act="lunch" data-id="'+d.id+'">'+(lunchText(d)?'Lunch break for '+esc(d.code)+': '+esc(lunchText(d)):'Set lunch break for '+esc(d.code))+'</button>';
  var nb=sl.filter(function(x){return !x.isBreak&&!isLunch(d.id,x.id)}).length;
  var grid='',summary='';
  var mk=function(r,day,s){
    if(s.isBreak)return '<td><div class="cell brk">'+esc(s.label)+'</div></td>';
    if(isLunch(d.id,s.id))return '<td><div class="cell brk">Lunch</div></td>';
    var e=S.tt.filter(function(t){return t.resId===r.id&&t.day===day&&t.slotId===s.id})[0];
    return e?'<td><button class="cell cls edit" style="--h:'+d.h+'" data-act="ttcell" data-id="'+e.id+'" data-res="'+r.id+'" data-day="'+day+'" data-slot="'+s.id+'"><b>'+esc(e.title)+'</b>'+(e.faculty?'<span>'+esc(e.faculty)+'</span>':'')+'<span>'+esc(classLabel(e.classId))+'</span></button></td>'
      :'<td><button class="cell free edit" data-act="ttcell" data-res="'+r.id+'" data-day="'+day+'" data-slot="'+s.id+'" aria-label="Add class '+DAYF[day]+' '+esc(s.label)+'"><i>+ Add</i></button></td>';
  };
  var tm=function(s){return '<th class="tm">'+esc(s.label)+'<small>'+s.start+'–'+s.end+'</small></th>'};
  if(ui.ttMode==='week'){
    var r=resById(ui.ttRes),used=S.tt.filter(function(t){return t.resId===r.id}).length;
    grid='<div class="seg">'+rs.map(function(x){return '<button class="btn sm'+(x.id===r.id?' on':'')+'" data-act="ttres" data-v="'+x.id+'">'+esc(x.name)+'</button>'}).join('')+'</div>'+
      '<div class="scroll"><table class="grid"><thead><tr><th class="tm">Period</th>'+DAYS.map(function(x,i){return '<th>'+DAYF[i]+'</th>'}).join('')+'</tr></thead><tbody>'+
      sl.map(function(s){return '<tr>'+tm(s)+DAYS.map(function(x,i){return mk(r,i,s)}).join('')+'</tr>'}).join('')+'</tbody></table></div>';
    summary=esc(r.name)+' · '+esc(r.type)+' · '+r.capacity+' seats · '+used+' of '+(6*nb)+' weekly slots in use';
  } else {
    var used2=S.tt.filter(function(t){return rs.some(function(r){return r.id===t.resId})&&t.day===ui.ttDay}).length;
    grid='<div class="seg">'+DAYF.map(function(x,i){return '<button class="btn sm'+(i===ui.ttDay?' on':'')+'" data-act="ttday" data-v="'+i+'">'+x+'</button>'}).join('')+'</div>'+
      '<div class="scroll"><table class="grid"><thead><tr><th class="tm">Period</th>'+rs.map(function(x){return '<th>'+esc(x.name)+'<small>'+x.capacity+' seats</small></th>'}).join('')+'</tr></thead><tbody>'+
      sl.map(function(s){return '<tr>'+tm(s)+rs.map(function(x){return mk(x,ui.ttDay,s)}).join('')+'</tr>'}).join('')+'</tbody></table></div>';
    summary=DAYF[ui.ttDay]+' · '+used2+' of '+(rs.length*nb)+' venue-periods scheduled';
  }
  return head+'<div class="filters" style="justify-content:space-between;align-items:center">'+modes+'<span class="note">'+summary+'</span></div>'+grid;
}

/* ---------- list filters ---------- */
function mfv(t,f){return ui.mf[t+'.'+f]||''}
var hit=function(q,arr){q=(q||'').trim().toLowerCase();return !q||arr.join(' ').toLowerCase().indexOf(q)>-1};
var mfTxt=function(t,label,ph){return '<label class="fld"><span>'+label+'</span><input type="search" id="mf-'+t+'-q" data-mf="'+t+'.q" value="'+esc(mfv(t,'q'))+'" placeholder="'+esc(ph||'Type to filter')+'" autocomplete="off"></label>'};
var mfSel=function(t,f,label,opts){return '<label class="fld"><span>'+label+'</span><select id="mf-'+t+'-'+f+'" data-mf="'+t+'.'+f+'">'+[['','All']].concat(opts).map(function(o){return '<option value="'+esc(o[0])+'"'+(String(o[0])===mfv(t,f)?' selected':'')+'>'+esc(o[1])+'</option>'}).join('')+'</select></label>'};
function mfBar(t,parts,shown,total){
  var on=Object.keys(ui.mf).some(function(k){return k.indexOf(t+'.')===0&&ui.mf[k]});
  return '<div class="panel mfbar"><div class="filters">'+parts.join('')+(on?'<button class="btn sm" data-act="mfclear" data-t="'+t+'">Clear filters</button>':'')+'<span class="note">'+shown+' of '+total+' shown</span></div></div>';
}
var bldOpts=function(){return S.buildings.slice().sort(function(a,b){return a.name.localeCompare(b.name)}).map(function(b){return [b.id,b.name]})};
var floorOpts=function(){return floorList().map(function(f){return [f.id,f.name]})};
var allocOpts=function(){return [['none','Central pool (unallocated)']].concat(S.depts.map(function(d){return [d.id,d.code+' – '+d.name]}))};
function resFilter(t){
  return S.resources.filter(function(r){
    var b=bldById(r.buildingId),f=floorById(r.floorId);
    return hit(mfv(t,'q'),[r.name,r.equipment||'',r.type,b?b.name:'',f?f.name:''])&&(!mfv(t,'type')||r.type===mfv(t,'type'))&&(!mfv(t,'bld')||r.buildingId===mfv(t,'bld'))&&(!mfv(t,'fl')||r.floorId===mfv(t,'fl'))&&(!mfv(t,'dept')||(mfv(t,'dept')==='none'?!r.deptId:r.deptId===mfv(t,'dept')));
  });
}
function resBar(t,L){return mfBar(t,[mfTxt(t,'Search','Name, equipment, building'),mfSel(t,'type','Type',TYPES.map(function(x){return [x,x]})),mfSel(t,'bld','Building',bldOpts()),mfSel(t,'fl','Floor',floorOpts()),mfSel(t,'dept','Allocated to',allocOpts())],L.length,S.resources.length)}
var noMatch=function(total,empty){return total?emptyBox('Nothing matches these filters.'):emptyBox(empty)};

function mDepts(){
  var L=S.depts.filter(function(d){return hit(mfv('depts','q'),[d.name,d.code])});
  return mfBar('depts',[mfTxt('depts','Search','Name or code')],L.length,S.depts.length)+'<div class="scroll"><table class="tbl"><thead><tr><th>Code</th><th>Department</th><th>Venues</th><th>Users</th><th>Lunch break</th><th></th></tr></thead><tbody>'+
  L.map(function(d){var k='dept:'+d.id;return '<tr><td>'+dtag(d.id)+'</td><td>'+esc(d.name)+'</td><td class="mono">'+S.resources.filter(function(r){return r.deptId===d.id}).length+'</td><td class="mono">'+S.users.filter(function(x){return deptIdsOf(x).indexOf(d.id)>-1}).length+'</td><td class="note">'+(lunchText(d)?esc(lunchText(d)):'<span class="muted">Not set</span>')+' <button class="link" data-act="lunch" data-id="'+d.id+'">Set</button></td><td class="act"><button class="btn sm" data-act="edit" data-t="dept" data-id="'+d.id+'">Edit</button><button class="btn sm danger" data-act="del" data-k="'+k+'">'+(ui.confirm===k?'Confirm delete':'Delete')+'</button></td></tr>'}).join('')+'</tbody></table></div>'+(L.length?'':noMatch(S.depts.length,'No departments yet.'));
}
function mBuildings(){
  var L=S.buildings.filter(function(b){return hit(mfv('bld','q'),[b.name])});
  return mfBar('bld',[mfTxt('bld','Search','Building name')],L.length,S.buildings.length)+'<div class="scroll"><table class="tbl"><thead><tr><th>Building</th><th>Venues</th><th></th></tr></thead><tbody>'+
  L.map(function(b){var k='bld:'+b.id;return '<tr><td><b>'+esc(b.name)+'</b></td><td class="mono">'+S.resources.filter(function(r){return r.buildingId===b.id}).length+'</td><td class="act"><button class="btn sm" data-act="edit" data-t="building" data-id="'+b.id+'">Edit</button><button class="btn sm danger" data-act="del" data-k="'+k+'">'+(ui.confirm===k?'Confirm delete':'Delete')+'</button></td></tr>'}).join('')+'</tbody></table></div>'+(L.length?'':noMatch(S.buildings.length,'No buildings yet. Add one before creating venues.'));
}
function mFloors(){
  var L=floorList().filter(function(f){return hit(mfv('floors','q'),[f.name,String(f.level)])});
  return mfBar('floors',[mfTxt('floors','Search','Floor name or level')],L.length,S.floors.length)+'<div class="scroll"><table class="tbl"><thead><tr><th>Floor</th><th>Level</th><th>Venues</th><th></th></tr></thead><tbody>'+
  L.map(function(f){var k='floor:'+f.id;return '<tr><td><b>'+esc(f.name)+'</b></td><td class="mono">'+f.level+'</td><td class="mono">'+S.resources.filter(function(r){return r.floorId===f.id}).length+'</td><td class="act"><button class="btn sm" data-act="edit" data-t="floor" data-id="'+f.id+'">Edit</button><button class="btn sm danger" data-act="del" data-k="'+k+'">'+(ui.confirm===k?'Confirm delete':'Delete')+'</button></td></tr>'}).join('')+'</tbody></table></div>'+(L.length?'':noMatch(S.floors.length,'No floors yet. Add one before creating venues.'));
}
function mClasses(){
  var rows=S.classes.slice().sort(function(a,b){return ((deptById(a.deptId)||{}).code||'').localeCompare((deptById(b.deptId)||{}).code||'')||a.year-b.year||a.section.localeCompare(b.section)});
  rows=rows.filter(function(c){return hit(mfv('classes','q'),[classLabel(c.id),c.section])&&(!mfv('classes','dept')||c.deptId===mfv('classes','dept'))&&(!mfv('classes','year')||String(c.year)===mfv('classes','year'))});
  return mfBar('classes',[mfTxt('classes','Search','e.g. CSE 3A'),mfSel('classes','dept','Department',S.depts.map(function(d){return [d.id,d.code+' – '+d.name]})),mfSel('classes','year','Year',[1,2,3,4,5,6].map(function(y){return [String(y),'Year '+y]}))],rows.length,S.classes.length)+'<div class="scroll"><table class="tbl"><thead><tr><th>Department</th><th>Year</th><th>Section</th><th>Label</th><th>Students</th><th>Periods / week</th><th></th></tr></thead><tbody>'+
  rows.map(function(c){var k='cls:'+c.id;return '<tr><td>'+dtag(c.deptId)+'</td><td class="mono">Year '+c.year+'</td><td class="mono">'+esc(c.section)+'</td><td><b>'+esc(classLabel(c.id))+'</b></td><td class="mono">'+(c.strength||'–')+'</td><td class="mono">'+S.tt.filter(function(t){return t.classId===c.id}).length+'</td><td class="act"><button class="btn sm" data-act="edit" data-t="class" data-id="'+c.id+'">Edit</button><button class="btn sm danger" data-act="del" data-k="'+k+'">'+(ui.confirm===k?'Confirm delete':'Delete')+'</button></td></tr>'}).join('')+'</tbody></table></div>'+(rows.length?'':noMatch(S.classes.length,'No years or sections yet. Add them so department heads can pick them in the timetable.'));
}
function vClasses(){
  var u=me(),head='<div class="head"><div><h2>Rooms by year and section</h2><p>See which classrooms and labs each year and section uses, and its full week.</p></div>';
  if(!S.depts.length)return head+'</div>'+emptyBox('No departments yet.');
  if(!ui.clDept||!deptById(ui.clDept))ui.clDept=(u.role==='hod'&&deptById(u.deptId))?u.deptId:S.depts[0].id;
  var d=deptById(ui.clDept),cl=classesOf(d.id),sl=slotList();
  head+='<label class="fld" style="min-width:240px">Department<select id="cl-dept" data-set="clDept">'+deptOpts().map(function(o){return '<option value="'+o[0]+'"'+(o[0]===ui.clDept?' selected':'')+'>'+esc(o[1])+'</option>'}).join('')+'</select></label></div>';
  if(!cl.length)return head+emptyBox(esc(d.code)+' has no years or sections yet. The administrator adds them in Masters → Years & sections.');
  if(!ui.clId||!cl.some(function(c){return c.id===ui.clId}))ui.clId=cl[0].id;
  var rows=cl.map(function(c){
    var ent=S.tt.filter(function(t){return t.classId===c.id}),cnt={};
    ent.forEach(function(t){cnt[t.resId]=(cnt[t.resId]||0)+1});
    var ids=Object.keys(cnt).sort(function(a,b){return cnt[b]-cnt[a]}),main=ids.filter(function(id){var r=resById(id);return r&&r.type==='Lecture theatre'})[0];
    return '<tr'+(c.id===ui.clId?' style="background:var(--accent-soft)"':'')+'><td><button class="btn sm'+(c.id===ui.clId?' on':'')+'" data-act="clsel" data-v="'+c.id+'">'+esc(classLabel(c.id))+'</button></td><td>'+(main?'<b>'+esc(resById(main).name)+'</b><br><span class="note">'+esc(locStr(resById(main)))+'</span>':'<span class="muted">–</span>')+'</td><td><div class="chips">'+(ids.length?ids.map(function(id){var r=resById(id);return '<span class="chip">'+esc(r?r.name:'?')+' ×'+cnt[id]+'</span>'}).join(''):'<span class="muted">No classes scheduled</span>')+'</div></td><td class="mono">'+ent.length+'</td></tr>';
  }).join('');
  var c=classById(ui.clId);
  var grid='<div class="scroll"><table class="grid"><thead><tr><th class="tm">Period</th>'+DAYF.map(function(n){return '<th>'+n+'</th>'}).join('')+'</tr></thead><tbody>'+sl.map(function(s){
    return '<tr><th class="tm">'+esc(s.label)+'<small>'+s.start+'–'+s.end+'</small></th>'+DAYF.map(function(n,i){
      if(s.isBreak||isLunch(d.id,s.id))return '<td><div class="cell brk">'+(s.isBreak?'Break':'Lunch')+'</div></td>';
      var e=S.tt.filter(function(t){return t.classId===c.id&&t.day===i&&t.slotId===s.id})[0],r=e&&resById(e.resId);
      return '<td>'+(e?'<div class="cell cls" style="--h:'+d.h+'" title="'+esc(r?locStr(r):'')+'"><b>'+esc(e.title)+'</b>'+(e.faculty?'<span>'+esc(e.faculty)+'</span>':'')+'<span>Room: '+esc(r?r.name:'?')+'</span></div>':'<div class="cell free"><i>–</i></div>')+'</td>'}).join('')+'</tr>'}).join('')+'</tbody></table></div>';
  return head+'<div class="scroll"><table class="tbl"><thead><tr><th>Year and section</th><th>Main classroom</th><th>All rooms used (periods per week)</th><th>Periods</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+
    '<section><h3 style="margin-bottom:10px">Week of '+esc(classFull(c))+'</h3>'+grid+'</section>';
}
function mSlots(){
  var L=slotList().filter(function(x){return hit(mfv('slots','q'),[x.label,x.start,x.end])&&(!mfv('slots','kind')||(mfv('slots','kind')==='break'?x.isBreak:!x.isBreak))});
  return mfBar('slots',[mfTxt('slots','Search','Label or time'),mfSel('slots','kind','Kind',[['period','Periods'],['break','Breaks']])],L.length,S.slots.length)+'<div class="scroll"><table class="tbl"><thead><tr><th>Label</th><th>Start</th><th>End</th><th>Minutes</th><th></th></tr></thead><tbody>'+
  L.map(function(s){var k='slot:'+s.id;return '<tr><td><b>'+esc(s.label)+'</b>'+(s.isBreak?' <span class="badge b-wait">Break</span>':'')+'</td><td class="mono">'+s.start+'</td><td class="mono">'+s.end+'</td><td class="mono">'+(toMin(s.end)-toMin(s.start))+'</td><td class="act"><button class="btn sm" data-act="edit" data-t="slot" data-id="'+s.id+'">Edit</button><button class="btn sm danger" data-act="del" data-k="'+k+'">'+(ui.confirm===k?'Confirm delete':'Delete')+'</button></td></tr>'}).join('')+'</tbody></table></div>'+(L.length?'':noMatch(S.slots.length,'No time slots yet.'));
}
function mRes(){
  var L=resFilter('res');
  return resBar('res',L)+'<div class="scroll"><table class="tbl"><thead><tr><th>Venue</th><th>Type</th><th>Building</th><th>Floor</th><th>Seats</th><th>Equipment</th><th>Allocated to</th><th></th></tr></thead><tbody>'+
  L.map(function(r){var k='res:'+r.id;return '<tr><td><b>'+esc(r.name)+'</b></td><td>'+tcode(r.type)+esc(r.type)+'</td><td>'+esc((bldById(r.buildingId)||{}).name||'–')+'</td><td>'+esc((floorById(r.floorId)||{}).name||'–')+'</td><td class="mono">'+r.capacity+'</td><td>'+esc(r.equipment)+'</td><td>'+dtag(r.deptId)+'</td><td class="act"><button class="btn sm" data-act="edit" data-t="resource" data-id="'+r.id+'">Edit</button><button class="btn sm danger" data-act="del" data-k="'+k+'">'+(ui.confirm===k?'Confirm delete':'Delete')+'</button></td></tr>'}).join('')+'</tbody></table></div>'+(L.length?'':noMatch(S.resources.length,'No venues yet.'));
}
function mUsers(){
  var L=S.users.filter(function(u){return hit(mfv('users','q'),[u.name,u.email||''])&&(!mfv('users','role')||u.role===mfv('users','role'))&&(!mfv('users','dept')||(mfv('users','dept')==='none'?!u.deptId:deptIdsOf(u).indexOf(mfv('users','dept'))>-1))});
  return mfBar('users',[mfTxt('users','Search','Name or email'),mfSel('users','role','Role',Object.keys(ROLE).map(function(k){return [k,ROLE[k]]})),mfSel('users','dept','Department',[['none','No department']].concat(S.depts.map(function(d){return [d.id,d.code+' – '+d.name]})))],L.length,S.users.length)+'<div class="scroll"><table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Department</th><th></th></tr></thead><tbody>'+
  L.map(function(u){var k='user:'+u.id;return '<tr><td><b>'+esc(u.name)+'</b></td><td>'+esc(u.email)+'</td><td>'+ROLE[u.role]+'</td><td>'+(u.deptId?deptIdsOf(u).map(function(i){return dtag(i)}).join(' '):'<span class="muted">–</span>')+'</td><td class="act"><button class="btn sm" data-act="edit" data-t="user" data-id="'+u.id+'">Edit</button><button class="btn sm danger" data-act="del" data-k="'+k+'">'+(ui.confirm===k?'Confirm delete':'Delete')+'</button></td></tr>'}).join('')+'</tbody></table></div>'+(L.length?'':noMatch(S.users.length,'No users yet.'));
}
function mAlloc(){
  var chips=S.depts.map(function(d){return '<span>'+dtag(d.id)+' <b class="mono">'+S.resources.filter(function(r){return r.deptId===d.id}).length+'</b></span>'}).join(' ')+' <span><span class="dtag central">Central pool</span> <b class="mono">'+S.resources.filter(function(r){return !r.deptId}).length+'</b></span>';
  var L=resFilter('alloc');
  return resBar('alloc',L)+'<p class="note" style="margin:0">A venue allocated to a department can be timetabled by that department head. Central pool venues have no timetable and stay open for events.</p><div class="chips" style="gap:14px">'+chips+'</div>'+
  '<div class="scroll"><table class="tbl"><thead><tr><th>Venue</th><th>Type</th><th>Seats</th><th>Classes per week</th><th>Allocated to</th></tr></thead><tbody>'+
  L.map(function(r){return '<tr><td><b>'+esc(r.name)+'</b></td><td>'+tcode(r.type)+esc(r.type)+'</td><td class="mono">'+r.capacity+'</td><td class="mono">'+S.tt.filter(function(t){return t.resId===r.id}).length+'</td><td><select id="alloc-'+r.id+'" data-alloc="'+r.id+'" aria-label="Allocate '+esc(r.name)+'">'+deptOpts('Central pool (no department)').map(function(o){return '<option value="'+o[0]+'"'+(o[0]===(r.deptId||'')?' selected':'')+'>'+esc(o[1])+'</option>'}).join('')+'</select></td></tr>'}).join('')+'</tbody></table></div>'+(L.length?'':noMatch(S.resources.length,'No venues yet.'));
}
function vMasters(){
  var subs=[['depts','Departments'],['classes','Years & sections'],['slots','Time slots'],['bld','Buildings'],['floors','Floors'],['res','Venues'],['users','Users'],['alloc','Allocation'],['track','Tracker mapping'],['loads','Load types'],['offdays','Off days']];
  var add={depts:['dept','Add department'],classes:['class','Add year & sections'],slots:['slot','Add time slot'],bld:['building','Add building'],floors:['floor','Add floor'],res:['resource','Add venue'],users:['user','Add user'],loads:['load','Add load type'],offdays:['offday','Add off day']}[ui.mtab];
  var body={depts:mDepts,classes:mClasses,slots:mSlots,bld:mBuildings,floors:mFloors,res:mRes,users:mUsers,alloc:mAlloc,track:mTrack,loads:mLoads,offdays:mOffdays}[ui.mtab]();
  var blurb2={track:'Choose which departments, years and sections take part in the Academic tracker. Only mapped ones appear in the weekly plan, the progress report and the leaderboard.',loads:'Types of teaching and training hours that department heads plan and track every week, such as theory, laboratory or aptitude training.',offdays:'Central holidays for every department. Use a date range for more than one day. Department heads mark their own sections’ off days in the Academic tracker. Saturdays and Sundays are off by default; add a working day to override.'};
  var blurb={depts:'Departments that own venues and timetables.',classes:'Years and sections of each department. Department heads pick them from a dropdown when they schedule a class.',slots:'The periods of a college day. Timetables and bookings use these.',bld:'Buildings and blocks. They appear as a dropdown when you create a venue.',floors:'Floors, ordered by level. They appear as a dropdown when you create a venue.',res:'Inventory of lecture theatres, computer labs, seminar halls and auditoriums.',users:'Everyone who signs in, with a role and, for department heads, a department.',alloc:'Assign each venue to a department or leave it in the central pool.'}[ui.mtab];
  return '<div class="head"><div><h2>Masters</h2><p>'+(blurb2[ui.mtab]||blurb)+'</p></div>'+(add?'<button class="btn primary" data-act="add" data-t="'+add[0]+'">'+add[1]+'</button>':'')+'</div>'+
    '<div class="seg">'+subs.map(function(s){return '<button class="btn sm'+(ui.mtab===s[0]?' on':'')+'" data-act="mtab" data-v="'+s[0]+'">'+s[1]+'</button>'}).join('')+'</div>'+body;
}

/* ---------- modal ---------- */
function moveSection(v){
  var cur=resById(v.resId),dep=cur&&deptById(cur.deptId),day=+v.mvDay,slot=v.mvSlot;
  var rs=S.resources.filter(function(r){return r.deptId===(cur&&cur.deptId)});
  var free=rs.filter(function(r){return !S.tt.some(function(t){return t.id!==v.id&&t.resId===r.id&&t.day===day&&t.slotId===slot})});
  var others=S.tt.filter(function(t){return t.id!==v.id&&t.day===day&&t.slotId===slot});
  var fac=(v.faculty||'').trim().toLowerCase(),cid=v.classId||'';
  var fc=fac&&others.filter(function(t){return t.faculty&&t.faculty.toLowerCase()===fac})[0];
  var cc=cid&&others.filter(function(t){return t.classId===cid})[0];
  var s=slotById(slot),moved=day!==v.day||slot!==v.slotId;
  var list;
  if(fc)list='<p class="err">'+esc(v.faculty)+' already teaches in '+esc(resById(fc.resId).name)+' at this time. Pick another period.</p>';
  else if(cc)list='<p class="err">'+esc(classLabel(v.classId))+' already has a class in '+esc(resById(cc.resId).name)+' at this time. Pick another period.</p>';
  else if(!free.length)list='<p class="note" style="margin:0">No '+esc(dep?dep.code:'department')+' venue is free in '+DAYF[day]+' '+(s?esc(s.label):'')+'. Try another day or period.</p>';
  else list='<div class="venlist" role="radiogroup" aria-label="Free venues">'+free.map(function(r){
    return '<label class="ven"><input type="radio" name="moveTo" value="'+r.id+'"'+(r.id===v.moveTo?' checked':'')+'><span><b>'+esc(r.name)+'</b>'+(r.id===v.resId?' <span class="badge b-ok">Current venue</span>':'')+'<br><span class="note">'+tcode(r.type)+esc(r.type)+' · '+r.capacity+' seats · '+esc(locStr(r))+'</span></span></label>'}).join('')+'</div>';
  return '<fieldset class="move"><legend>Move this class</legend><p class="note" style="margin:0">Choose a new day and period, then pick one of the free '+esc(dep?dep.code:'')+' venues. '+(moved?'<b>Moving from '+DAYF[v.day]+' '+esc(slotById(v.slotId).label)+'.</b>':'Leave as is to keep the class where it is.')+'</p>'+
    '<div class="frow">'+fld('Day',sel('mvDay',DAYF.map(function(n,i){return [i,n]}),day).replace('<select ','<select data-mv="1" '))+fld('Period',sel('mvSlot',slotOpts(),slot).replace('<select ','<select data-mv="1" '))+'</div>'+list+'</fieldset>';
}
function modalHTML(){
  var m=ui.modal;if(!m)return '';
  var v=m.vals||{},title='',body='',extra='';
  switch(m.type){
    case 'dept':title=(v.id?'Edit':'Add')+' department';
      body=fld('Department name',tin('name',v.name,'required autocomplete="off"'))+fld('Short code',tin('code',v.code,'required maxlength="6" autocomplete="off"'));break;
    case 'class':title=(v.id?'Edit':'Add')+' year and section';
      body=fld('Department',sel('deptId',deptOpts(),v.deptId||(S.depts[0]||{}).id))+'<div class="frow">'+fld('Year',sel('year',[1,2,3,4,5,6].map(function(y){return [y,'Year '+y]}),v.year||1))+fld(v.id?'Section':'Sections',tin('section',v.section,'required placeholder="A, B, C" autocomplete="off"'))+'</div>'+fld('Students per section (optional)',tin('strength',v.strength||'','type="number" min="0"'))+(v.id?'':'<p class="note" style="margin:0">Enter several sections separated by commas to add them together.</p>');break;
    case 'building':title=(v.id?'Edit':'Add')+' building';
      body=fld('Building name',tin('name',v.name,'required autocomplete="off"'));break;
    case 'floor':title=(v.id?'Edit':'Add')+' floor';
      body=fld('Floor name',tin('name',v.name,'required placeholder="4th floor" autocomplete="off"'))+fld('Level (0 = ground, -1 = basement)',tin('level',v.level==null?'':v.level,'type="number" step="1" required'));break;
    case 'slot':title=(v.id?'Edit':'Add')+' time slot';
      body=fld('Label',tin('label',v.label,'required maxlength="14"'))+'<div class="frow">'+fld('Start',tin('start',v.start||'09:00','type="time" required'))+fld('End',tin('end',v.end||'10:00','type="time" required'))+'</div><label class="chk"><input type="checkbox" name="isBreak" value="1"'+(v.isBreak?' checked':'')+'> This is a break (lunch). No classes or events can be placed in it.</label>';break;
    case 'resource':title=(v.id?'Edit':'Add')+' venue';
      body=fld('Name',tin('name',v.name,'required'))+'<div class="frow">'+fld('Type',sel('type',TYPES.map(function(t){return [t,t]}),v.type||TYPES[0]))+fld('Seats',tin('capacity',v.capacity||'','type="number" min="1" required'))+'</div>'+'<div class="frow">'+fld('Building',sel('buildingId',S.buildings.map(function(b){return [b.id,b.name]}),v.buildingId||(S.buildings[0]||{}).id))+fld('Floor',sel('floorId',floorList().map(function(f){return [f.id,f.name]}),v.floorId||(floorList()[0]||{}).id))+'</div>'+fld('Equipment',tin('equipment',v.equipment))+fld('Allocated to',sel('deptId',deptOpts('Central pool (no department)'),v.deptId||''));break;
    case 'load':title=(v.id?'Edit':'Add')+' load type';
      body=fld('Name',tin('name',v.name,'required maxlength="60" placeholder="Theory lectures"'))+fld('Kind',sel('kind',LOAD_KINDS.map(function(k){return [k,k]}),v.kind||'Academic'));break;
    case 'offday':title=(v.id?'Edit':'Mark')+' off day';
      extra='<p class="ctx">'+(me().role==='admin'?'Choose “All departments” for a central holiday, or one year and section.':'The off day applies to the years and sections you choose.')+' Use the last day to cover more than one day. Saturdays and Sundays are already off; choose Working day to override that.</p>';
      body=fld('Title',tin('title',v.title,'required maxlength="120" placeholder="Gandhi Jayanti"'))+'<div class="frow">'+fld('First day',tin('dateFrom',v.dateFrom||today,'type="date" required'))+fld('Last day',tin('dateTo',v.dateTo||v.dateFrom||today,'type="date" required'))+'</div>'+fld('This is',sel('kind',[['off','Off day (no classes)'],['working','Working day (turn an off day into a working day)']],v.kind||'off'))+fld('Applies to',scopeHTML(v.scope!==undefined?v.scope:(v.classId||(me().role==='admin'?'':'D:'+ui.trDept))));break;
    case 'user':title=(v.id?'Edit':'Add')+' user';
      body=fld('Full name',tin('name',v.name,'required'))+fld('Email (used to sign in)',tin('email',v.email,'type="email" required autocomplete="off"'))+fld(v.id?'New password (leave empty to keep the current one)':'Password',tin('password','','type="password" minlength="8" autocomplete="new-password"'+(v.id?'':' required')))+'<div class="frow">'+fld('Role',sel('role',Object.keys(ROLE).map(function(k){return [k,ROLE[k]]}),v.role||'stakeholder'))+fld('Main department (department heads)',sel('deptId',deptOpts('None'),v.deptId||''))+'</div>'+'<fieldset class="move"><legend>Also manages (department heads only)</legend><div class="chips">'+S.depts.map(function(dx){return '<label class="chk"><input type="checkbox" name="moreDeptIds" value="'+dx.id+'"'+((v.moreDeptIds||[]).indexOf(dx.id)>-1?' checked':'')+'> '+esc(dx.code)+'</label>'}).join('')+'</div><p class="note" style="margin:6px 0 0">A head can build timetables, set lunch breaks, mark classes away and lend venues for every department ticked here, as well as the main one.</p></fieldset>';break;
    case 'tt':{var r=resById(v.resId),s=slotById(v.slotId);title=(v.id?'Edit':'Add')+' class';
      extra='<p class="ctx"><b>'+esc(r?r.name:'')+'</b> · '+DAYF[v.day]+' · '+(s?esc(s.label)+' '+s.start+'–'+s.end:'')+'</p>';
      body=fld('Subject or session',tin('title',v.title,'required autocomplete="off"'))+'<div class="frow">'+fld('Faculty (optional)',tin('faculty',v.faculty,'autocomplete="off"'))+fld('Year and section',(function(){var dc=r?classesOf(r.deptId):[];return dc.length?sel('classId',[['','Choose year and section']].concat(dc.map(function(c){return [c.id,classFull(c)+(c.strength?' ('+c.strength+' students)':'')]})),v.classId||(!v.id&&dc.some(function(c){return c.id===ui.lastClass})?ui.lastClass:'')):'<span class="err">No years or sections exist for this department. Add them in Masters → Years & sections.</span>'})())+'</div>'+(v.id?moveSection(v)+(v.classId&&me().role!=='stakeholder'?'<p class="note" style="margin:0">Class away on a particular day? <button type="button" class="btn sm" data-act="gochange" data-cls="'+esc(v.classId)+'">Release this class for a date</button></p>':''):'');break}
    case 'lunch':{var ld=deptById(v.id);title='Lunch break · '+(ld?esc(ld.code):'');
      extra='<p class="ctx">Tick the period or periods when '+(ld?esc(ld.name):'this department')+' has lunch. Its classes cannot be scheduled then, and its venues show as free for other uses. Other departments are not affected.</p>';
      var lv=[].concat(v.lunch||[]).map(String);
      body='<fieldset class="days"><legend>Lunch periods</legend>'+slotOpts().map(function(o){return '<label class="chk"><input type="checkbox" name="lunch" value="'+o[0]+'"'+(lv.indexOf(String(o[0]))>-1?' checked':'')+'> '+esc(o[1])+'</label>'}).join('')+'</fieldset>';break}
    case 'fullday':{title='Allot a full day';
      var fdD=deptById(me().role==='admin'?ui.ttDept:hodDept(ui.ttDept)),fdRs=S.resources.filter(function(x){return fdD&&x.deptId===fdD.id}),fdCl=fdD?classesOf(fdD.id):[];
      var fdDays=[].concat(v.days||[]).map(String);
      extra='<p class="ctx">One subject and one section for several periods in a row, on one or more days. Periods that are already taken, and breaks, are skipped.</p>';
      body=fld('Venue',sel('resId',fdRs.map(function(x){return [x.id,x.name+' ('+x.capacity+' seats)']}),v.resId))+
        '<fieldset class="days"><legend>Days</legend>'+DAYF.map(function(n,i){return '<label class="chk"><input type="checkbox" name="days" value="'+i+'"'+(fdDays.indexOf(String(i))>-1?' checked':'')+'> '+n+'</label>'}).join('')+'</fieldset>'+
        '<div class="frow">'+fld('From period',sel('from',slotOpts(),v.from))+fld('To period',sel('to',slotOpts(),v.to))+'</div>'+
        fld('Year and section',sel('classId',[['','Choose year and section']].concat(fdCl.map(function(c){return [c.id,classFull(c)]})),v.classId||''))+
        fld('Subject or session',tin('title',v.title,'required autocomplete="off"'))+fld('Faculty (optional)',tin('faculty',v.faculty,'autocomplete="off"'));break}
    case 'lend':{var du=deptById(me().deptId),ownAll=S.resources.filter(function(r){return myDepts().indexOf(r.deptId)>-1}),lwin=slotRange(v.from,v.to),
        ownR=(v.date&&v.date>=today&&lwin.length)?ownAll.filter(function(r){return lwin.every(function(sx){return !busyAt(r.id,v.date,sx.id)})}):[],
        r3;
      if(!ownR.some(function(r){return r.id===v.resId}))v.resId=ownR.length?ownR[0].id:'';
      r3=resById(v.resId);title='Lend a venue';
      extra='<p class="ctx">Booked for someone else from '+(du?esc(du.name):'your department')+'’s venues. It is confirmed immediately.'+(r3?' '+esc(r3.type)+' · '+r3.capacity+' seats · '+esc(locStr(r3)):'')+'</p>';
      var lsel=function(n,val){return sel(n,slotOpts(),val).replace('<select ','<select data-lendref="1" ')};
      body='<div class="frow">'+fld('Date',tin('date',v.date,'type="date" required data-lendref="1"'))+fld('Expected attendees',tin('attendees',v.attendees||'','type="number" min="1"'))+'</div><div class="frow">'+fld('From',lsel('from',v.from))+fld('To',lsel('to',v.to))+'</div>'+
        fld('Venue (only venues free at that time)',ownR.length?sel('resId',ownR.map(function(r){return [r.id,r.name+' ('+r.capacity+' seats)']}),v.resId):'<p class="err" style="margin:0">None of '+(myDepts().length?esc(deptLabel(myDepts())):'your')+' venues is free for that whole time. Change the date or time.</p>')+
        fld('Lend to',lendToHTML(v.toWho))+fld('Name, only if “Someone else”',tin('forName',v.forName,'autocomplete="off"'))+fld('Purpose',tin('title',v.title,'required autocomplete="off" placeholder="Guest lecture, exam, workshop"'))+fld('Notes',tin('notes',v.notes,'placeholder="Equipment, seating, contact person"'));break}
    case 'book':{var r2=resById(v.resId);title='Book '+(r2?r2.name:'venue');
      extra='<p class="ctx">'+(r2?esc(r2.type)+' · '+r2.capacity+' seats · '+esc(locStr(r2)):'')+'</p>';
      body=fld('Event title',tin('title',v.title,'required autocomplete="off"'))+'<div class="frow">'+fld('Date',tin('date',v.date,'type="date" required'))+fld('Expected attendees',tin('attendees',v.attendees||'','type="number" min="1"'))+'</div><div class="frow">'+fld('From',sel('from',slotOpts(),v.from))+fld('To',sel('to',slotOpts(),v.to))+'</div>'+fld('Organiser',tin('by',v.by,'required'+(me().role==='stakeholder'?' readonly':'')))+fld('Notes',tin('notes',v.notes,'placeholder="Equipment, speakers, seating"'));
      if(!canApprove())extra+='<p class="note" style="margin:0">Your request is sent to the head of institute. The slots are held until it is approved or declined.</p>';break}
  }
  var del=m.type==='tt'&&v.id?'<button type="button" class="btn danger" data-act="ttdel" data-id="'+v.id+'" style="margin-right:auto">Delete class</button>':'';
  return '<div class="overlay" data-act="closeModal"><form class="modal" data-form="'+m.type+'" role="dialog" aria-modal="true" aria-label="'+esc(title)+'" novalidate><h2>'+esc(title)+'</h2>'+(m.err?'<p class="err" role="alert">'+esc(m.err)+'</p>':'')+extra+body+'<div class="mfoot">'+del+'<button type="button" class="btn" data-act="closeModal">Cancel</button><button type="submit" class="btn primary">'+(m.type==='book'?(canApprove()?'Confirm booking':'Send request'):m.type==='lend'?'Lend venue':'Save')+'</button></div></form></div>';
}

/* ---------- render ---------- */
var brandSvg='<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true"><g fill="none" stroke="var(--accent)" stroke-width="1.5"><rect x="1" y="1" width="28" height="28" rx="3"/><path d="M1 10h28M1 20h28M10 1v28M20 1v28"/></g><rect x="11" y="11" width="8" height="8" fill="var(--accent)"/><rect x="2" y="2" width="7" height="7" fill="var(--accent)" opacity=".35"/><rect x="21" y="21" width="7" height="7" fill="var(--accent)" opacity=".35"/></svg>';
function vLogin(){
  return '<div class="login"><form class="panel" data-login="1" novalidate><h2>Sign in</h2><p class="note" style="margin:0">Use the email address and password your administrator gave you.</p>'+
    (ui.loginErr?'<p class="err" role="alert">'+esc(ui.loginErr)+'</p>':'')+
    fld('Email','<input id="login-email" name="email" type="email" autocomplete="username" required>')+
    fld('Password','<input id="login-password" name="password" type="password" autocomplete="current-password" required>')+
    '<button type="submit" class="btn primary"'+(ui.loginBusy?' disabled':'')+'>'+(ui.loginBusy?'Signing in…':'Sign in')+'</button></form></div>';
}
function render(){
  var head=document.getElementById('topbar'),brand='<div class="brand">'+brandSvg+'<div><h1>Campus Resource Planner</h1><small>Lecture theatres, labs, seminar halls and auditoriums</small></div></div>';
  var y=window.scrollY;
  if(ui.booting){head.classList.add('gated');head.innerHTML='<div class="bar">'+brand+'</div>';document.getElementById('main').innerHTML='<div class="empty">Loading…</div>';document.getElementById('modalRoot').innerHTML='';document.getElementById('foot').innerHTML='';return}
  if(!ui.userId){head.classList.add('gated');head.innerHTML='<div class="bar">'+brand+'</div>';document.getElementById('main').innerHTML=vLogin();document.getElementById('modalRoot').innerHTML='';document.getElementById('foot').innerHTML='';return}
  ensure();
  var u=me(),tabs=tabsFor(u.role);
  if(!tabs.some(function(t){return t[0]===ui.tab}))ui.tab=tabs[0][0];
  head.classList.remove('gated');
  head.innerHTML='<div class="bar">'+brand+
    '<div class="who"><span id="sync" class="syncwrap"></span><span class="me" title="'+esc(u.email)+'"><b>'+esc(u.name)+'</b> · '+ROLE[u.role]+'</span><button class="btn sm" data-act="logout">Sign out</button><button class="btn sm" data-act="logoutall" title="Sign out on every device where you are signed in">Sign out everywhere</button></div></div>'+
    '<nav class="tabs" role="tablist" aria-label="Sections">'+tabs.map(function(t){return '<button class="tab" role="tab" aria-selected="'+(t[0]===ui.tab)+'" data-act="tab" data-v="'+t[0]+'">'+t[1]+'</button>'}).join('')+'</nav>';
  document.getElementById('main').innerHTML={overview:vOverview,avail:vAvail,events:vEvents,lend:vLend,track:vTrack,timetable:vTimetable,classes:vClasses,changes:vChanges,masters:vMasters}[ui.tab]();
  document.getElementById('modalRoot').innerHTML=modalHTML();
  document.getElementById('foot').innerHTML='<span>Signed in as '+esc(u.email||u.name)+'</span>';
  updateSync();
  window.scrollTo(0,y);
  if(ui.modal&&!ui.modal.focused){var f=document.querySelector('.modal input,.modal select');if(f)f.focus();ui.modal.focused=true}
}

/* ---------- actions ---------- */
var tmr;
function toast(msg,bad){var t=document.getElementById('toast');t.textContent=msg;t.className='toast show'+(bad?' bad':'');clearTimeout(tmr);tmr=setTimeout(function(){t.className='toast'},3800)}
function open(type,vals){ui.modal={type:type,vals:vals||{},err:''};ui.confirm=null;render()}
function fail(msg,fd){ui.modal.vals=Object.assign({},ui.modal.vals,fd);ui.modal.err=msg;ui.modal.focused=true;render();var e=document.querySelector('.modal .err');if(e)e.scrollIntoView({block:'nearest'})}
function done(msg){ui.modal=null;save();render();toast(msg)}

function openBook(resId,from,to){
  var u=me();open('book',{resId:resId,date:ui.avDate,from:from,to:to,title:'',by:u.name,attendees:'',notes:''});
}

function submitForm(type,d){
  var base=ui.modal.vals,v=Object.assign({},base,d),i,o;
  if(type==='dept'){
    v.name=(v.name||'').trim();v.code=(v.code||'').trim().toUpperCase();
    if(!v.name||!v.code)return fail('Enter a name and a short code.',d);
    if(S.depts.some(function(x){return x.id!==v.id&&x.code===v.code}))return fail('Another department already uses the code '+v.code+'.',d);
    if(v.id){o=deptById(v.id);o.name=v.name;o.code=v.code}else S.depts.push({id:uid('d_'),name:v.name,code:v.code,h:(S.depts.length*67+205)%360});
    return done('Department saved.');
  }
  if(type==='class'){
    if(!deptById(v.deptId))return fail('Choose a department.',d);
    var yr=parseInt(v.year,10),secs=String(v.section||'').split(',').map(function(x){return x.trim().toUpperCase()}).filter(Boolean),stn=parseInt(v.strength,10)||0;
    if(!secs.length)return fail('Enter a section such as A.',d);
    if(v.id&&secs.length>1)return fail('Edit one section at a time.',d);
    for(i=0;i<secs.length;i++){if(S.classes.some(function(x){return x.id!==v.id&&x.deptId===v.deptId&&x.year===yr&&x.section===secs[i]}))return fail(deptById(v.deptId).code+' '+yr+secs[i]+' already exists.',d)}
    if(v.id){o=classById(v.id);if(o.deptId!==v.deptId&&S.tt.some(function(t){return t.classId===o.id}))return fail('This section has timetable classes. Clear them before moving it to another department.',d);o.deptId=v.deptId;o.year=yr;o.section=secs[0];o.strength=stn}
    else secs.forEach(function(sec){S.classes.push({id:uid('c'),deptId:v.deptId,year:yr,section:sec,strength:stn})});
    return done(secs.length>1?secs.length+' sections added.':'Year and section saved.');
  }
  if(type==='building'){
    v.name=(v.name||'').trim();
    if(!v.name)return fail('Enter a building name.',d);
    if(S.buildings.some(function(x){return x.id!==v.id&&x.name.toLowerCase()===v.name.toLowerCase()}))return fail(v.name+' already exists.',d);
    if(v.id)bldById(v.id).name=v.name;else S.buildings.push({id:uid('b'),name:v.name});
    return done('Building saved.');
  }
  if(type==='floor'){
    v.name=(v.name||'').trim();var lv=parseInt(v.level,10);
    if(!v.name)return fail('Enter a floor name.',d);
    if(isNaN(lv))return fail('Enter the floor level as a number.',d);
    if(S.floors.some(function(x){return x.id!==v.id&&(x.name.toLowerCase()===v.name.toLowerCase()||x.level===lv)}))return fail('A floor with this name or level already exists.',d);
    if(v.id){o=floorById(v.id);o.name=v.name;o.level=lv}else S.floors.push({id:uid('f'),name:v.name,level:lv});
    return done('Floor saved.');
  }
  if(type==='load'){
    v.name=(v.name||'').trim();
    if(!v.name)return fail('Enter a name such as Theory lectures.',d);
    if(LOAD_KINDS.indexOf(v.kind)<0)return fail('Choose Academic or Training.',d);
    if(S.loads.some(function(l){return l.id!==v.id&&l.name.toLowerCase()===v.name.toLowerCase()}))return fail('A load type with that name already exists.',d);
    if(v.id){o=S.loads.filter(function(l){return l.id===v.id})[0];o.name=v.name;o.kind=v.kind}else S.loads.push({id:uid('l'),name:v.name,kind:v.kind});
    return done('Load type saved.');
  }
  if(type==='offday'){
    v.title=(v.title||'').trim();
    if(!v.title)return fail('Enter a title such as Gandhi Jayanti or Working Saturday.',d);
    if(!v.dateFrom||!v.dateTo)return fail('Choose the first and last day.',d);
    if(v.dateTo<v.dateFrom)return fail('The last day cannot be before the first day.',d);
    if((Date.parse(v.dateTo)-Date.parse(v.dateFrom))/864e5>366)return fail('An off-day range can be at most one year.',d);
    var sc=v.scope||'',ids=scopeIds(sc);
    v.kind=v.kind==='working'?'working':'off';
    if(sc===''&&me().role!=='admin')return fail('Choose the years and sections this off day applies to.',d);
    if(!ids.length)return fail('That department has no years or sections yet.',d);
    if(v.id){o=S.holidays.filter(function(h){return h.id===v.id})[0];o.title=v.title;o.dateFrom=v.dateFrom;o.dateTo=v.dateTo;o.kind=v.kind;o.classId=ids[0];if(ids.length>1)ids.slice(1).forEach(function(cid){S.holidays.push({id:uid('h'),dateFrom:v.dateFrom,dateTo:v.dateTo,title:v.title,classId:cid,kind:v.kind,by:me().name})})}
    else ids.forEach(function(cid){S.holidays.push({id:uid('h'),dateFrom:v.dateFrom,dateTo:v.dateTo,title:v.title,classId:cid,kind:v.kind,by:me().name})});
    return done(v.kind==='working'?'Working day saved.':'Off day saved.');
  }
  if(type==='slot'){
    v.label=(v.label||'').trim();
    if(!v.label)return fail('Enter a label such as P1.',d);
    if(!v.start||!v.end||toMin(v.end)<=toMin(v.start))return fail('The end time must be after the start time.',d);
    var clash=S.slots.filter(function(s){return s.id!==v.id&&toMin(s.start)<toMin(v.end)&&toMin(v.start)<toMin(s.end)})[0];
    if(clash)return fail('This overlaps '+clash.label+' ('+clash.start+'–'+clash.end+').',d);
    var brk=!!d.isBreak;
    if(brk&&v.id&&(S.tt.some(function(t){return t.slotId===v.id})||S.events.some(function(e){return e.slotIds.indexOf(v.id)>-1})))return fail('This period already has classes or events. Remove them before marking it as a break.',d);
    if(v.id){o=slotById(v.id);o.label=v.label;o.start=v.start;o.end=v.end;o.isBreak=brk}else S.slots.push({id:uid('s'),label:v.label,start:v.start,end:v.end,isBreak:brk});
    return done('Time slot saved.');
  }
  if(type==='resource'){
    v.name=(v.name||'').trim();var cap=parseInt(v.capacity,10);
    if(!v.name)return fail('Enter a venue name.',d);
    if(!(cap>0))return fail('Enter the number of seats.',d);
    if(!bldById(v.buildingId)||!floorById(v.floorId))return fail('Choose a building and a floor. Add them in Masters if the lists are empty.',d);
    if(S.resources.some(function(x){return x.id!==v.id&&x.name.toLowerCase()===v.name.toLowerCase()}))return fail('A venue named '+v.name+' already exists.',d);
    var dep=v.deptId||null;
    if(v.id){o=resById(v.id);
      if(o.deptId!==dep){var n=S.tt.filter(function(t){return t.resId===o.id}).length;if(n)return fail(o.name+' has '+n+' timetable classes for its current department. Clear them before moving it.',d)}
      o.name=v.name;o.type=v.type;o.buildingId=v.buildingId;o.floorId=v.floorId;o.capacity=cap;o.equipment=(v.equipment||'').trim();o.deptId=dep;
    } else S.resources.push({id:uid('r'),name:v.name,type:v.type,buildingId:v.buildingId,floorId:v.floorId,capacity:cap,equipment:(v.equipment||'').trim(),deptId:dep});
    return done('Venue saved.');
  }
  if(type==='user'){
    d.moreDeptIds=[].concat(d.moreDeptIds||[]).filter(Boolean);v.moreDeptIds=d.moreDeptIds;
    v.name=(v.name||'').trim();v.email=(v.email||'').trim().toLowerCase();var pw=d.password||'';
    delete d.password;delete v.password;
    if(!v.name)return fail('Enter the user’s name.',d);
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email))return fail('Enter a valid email address. It is the user’s sign-in name.',d);
    if(S.users.some(function(x){return x.id!==v.id&&x.email.toLowerCase()===v.email}))return fail('Another user already has that email address.',d);
    if(!v.id&&pw.length<8)return fail('Set a password of at least 8 characters.',d);
    if(pw&&(pw.length<8||pw.length>72))return fail('A password must be 8 to 72 characters.',d);
    if(v.role==='hod'&&!v.deptId)return fail('A department head needs a department.',d);
    if(v.id&&base.role==='admin'&&v.role!=='admin'&&S.users.filter(function(x){return x.role==='admin'}).length<2)return fail('Keep at least one administrator.',d);
    var dp=v.role==='hod'?(v.deptId||null):null,more=v.role==='hod'?v.moreDeptIds.filter(function(x){return x!==dp&&deptById(x)}):[];
    if(v.id){o=S.users.filter(function(x){return x.id===v.id})[0];o.name=v.name;o.email=v.email;o.role=v.role;o.deptId=dp;o.moreDeptIds=more;if(pw)o.password=pw}else{var nu={id:uid('u'),name:v.name,email:v.email,role:v.role,deptId:dp,moreDeptIds:more,password:pw};S.users.push(nu)}
    return done('User saved.');
  }
  if(type==='lunch'){
    var lids=[].concat(d.lunch||[]),ldp=deptById(v.id);
    if(!ldp)return fail('Department not found.',d);
    var clash2=S.tt.filter(function(t){var c=classById(t.classId);return c&&c.deptId===ldp.id&&lids.indexOf(t.slotId)>-1}).length;
    if(clash2)return fail(ldp.code+' already has '+clash2+' class'+(clash2===1?'':'es')+' in those periods. Remove or move them first.',d);
    ldp.lunchSlots=lids;
    return done(lids.length?'Lunch break saved for '+ldp.code+'.':'Lunch break cleared for '+ldp.code+'.');
  }
  if(type==='fullday'){
    v.title=(v.title||'').trim();v.faculty=(v.faculty||'').trim();
    var days=[].concat(v.days||[]).map(Number).filter(function(x){return x>=0&&x<=5});
    if(!v.resId||!resById(v.resId))return fail('Choose a venue.',d);
    if(!days.length)return fail('Tick at least one day.',d);
    if(!v.classId||!classById(v.classId))return fail('Choose the year and section from the list.',d);
    if(!v.title)return fail('Enter the subject or session.',d);
    var cdept=classById(v.classId).deptId;
    var win=slotRange(v.from,v.to).filter(function(x){return !isLunch(cdept,x.id)});
    if(!win.length)return fail('Choose the periods.',d);
    var added=0,skipped=0;
    days.forEach(function(day){win.forEach(function(sl){
      var taken=S.tt.some(function(t){return t.day===day&&t.slotId===sl.id&&(t.resId===v.resId||t.classId===v.classId||(v.faculty&&t.faculty&&t.faculty.toLowerCase()===v.faculty.toLowerCase()))});
      if(taken){skipped++;return}
      S.tt.push({id:uid('t'),resId:v.resId,day:day,slotId:sl.id,title:v.title,faculty:v.faculty,classId:v.classId});added++;
    })});
    if(!added)return fail('Nothing was added. Every selected period is already taken.',d);
    ui.lastClass=v.classId;ui.ttRes=v.resId;
    return done(added+' period'+(added===1?'':'s')+' added'+(skipped?', '+skipped+' skipped because they were already taken':'')+'.');
  }
  if(type==='tt'){
    v.title=(v.title||'').trim();v.faculty=(v.faculty||'').trim();v.classId=v.classId||'';
    if(!v.title)return fail('Enter the subject or session.',d);
    if(!v.classId||!classById(v.classId))return fail('Choose the year and section from the list.',d);
    var ed=!!v.id,day=ed?+v.mvDay:+v.day,slotId=ed?v.mvSlot:v.slotId,resId=ed?(d.moveTo||''):v.resId;
    if(ed&&!resId)return fail('Choose a venue from the free list.',d);
    if(isLunch(classById(v.classId).deptId,slotId))return fail('That period is the lunch break of '+deptById(classById(v.classId).deptId).code+'. Choose another period.',d);
    if(S.tt.some(function(t){return t.id!==v.id&&t.resId===resId&&t.day===day&&t.slotId===slotId}))return fail(resById(resId).name+' is not free at that time.',d);
    var others=S.tt.filter(function(t){return t.id!==v.id&&t.day===day&&t.slotId===slotId});
    var fc=v.faculty&&others.filter(function(t){return t.faculty&&t.faculty.toLowerCase()===v.faculty.toLowerCase()})[0];
    if(fc)return fail(v.faculty+' already teaches in '+resById(fc.resId).name+' in this period.',d);
    var cc=others.filter(function(t){return t.classId===v.classId})[0];
    if(cc)return fail(classLabel(v.classId)+' already has a class in '+resById(cc.resId).name+' in this period.',d);
    if(v.id){o=S.tt.filter(function(t){return t.id===v.id})[0];var mv=o.resId!==resId||o.day!==day||o.slotId!==slotId;if(o.day!==day||o.slotId!==slotId)S.releases=S.releases.filter(function(r){return r.ttId!==o.id});o.title=v.title;o.faculty=v.faculty;o.classId=v.classId;ui.lastClass=v.classId;o.resId=resId;o.day=day;o.slotId=slotId;if(mv){ui.ttRes=resId;ui.ttDay=day;return done('Moved to '+resById(resId).name+', '+DAYF[day]+' '+slotById(slotId).label+'.')}}else S.tt.push({id:uid('t'),resId:resId,day:day,slotId:slotId,title:v.title,faculty:v.faculty,classId:v.classId});ui.lastClass=v.classId;
    return done('Class saved.');
  }
  if(type==='lend'){
    var u0=me(),lr=resById(v.resId);
    v.title=(v.title||'').trim();
    if(!lr||myDepts().indexOf(lr.deptId)<0)return fail('No venue of yours is free at that time. Change the date or time.',d);
    if(!v.title||!v.date)return fail('Enter the purpose and the date.',d);
    if(v.date<today)return fail('Choose today or a later date.',d);
    if(!v.toWho)return fail('Choose who the venue is lent to.',d);
    var who=String(v.toWho),byTxt='',fdept=null;
    if(who.indexOf('d:')===0){var dd=deptById(who.slice(2));if(!dd||myDepts().indexOf(dd.id)>-1)return fail('Choose a different department.',d);byTxt='Department of '+dd.name+' ('+dd.code+')';fdept=dd.id}
    else if(who.indexOf('h:')===0){var hh=S.users.filter(function(x){return x.id===who.slice(2)})[0];if(!hh||!hh.deptId||myDepts().indexOf(hh.deptId)>-1)return fail('Choose another department head.',d);var hd=deptById(hh.deptId);byTxt=hh.name+(hd?' (HoD, '+hd.code+')':'');fdept=hh.deptId}
    else{byTxt=(v.forName||'').trim();if(!byTxt)return fail('Type the name of the person or organisation.',d)}
    var sp=slotRange(v.from,v.to),lat=parseInt(v.attendees,10)||0;
    if(!sp.length)return fail('Choose a time that is not a break.',d);
    if(lat>lr.capacity)return fail(lr.name+' seats '+lr.capacity+'. Reduce attendees or pick a larger venue.',d);
    for(i=0;i<sp.length;i++){var bb=busyAt(lr.id,v.date,sp[i].id);
      if(bb)return fail(lr.name+' is not free in '+sp[i].label+' on '+fmtDate(v.date)+' ('+(bb.kind==='class'?'class: '+bb.e.title:'event: '+bb.ev.title)+').',d)}
    S.events.push({id:uid('e'),resId:lr.id,date:v.date,slotIds:sp.map(function(s){return s.id}),title:v.title,by:byTxt,attendees:lat,notes:(v.notes||'').trim(),status:'confirmed',forDeptId:fdept,lentDeptId:lr.deptId,lentBy:u0.name});
    return done('Lent '+lr.name+' to '+byTxt+'.');
  }
  if(type==='book'){
    v.title=(v.title||'').trim();v.by=me().role==='stakeholder'?me().name:(v.by||'').trim();
    if(!v.title||!v.by||!v.date)return fail('Enter a title, a date and the organiser.',d);
    if(v.date<today)return fail('Choose today or a later date.',d);
    var span=slotRange(v.from,v.to),r=resById(v.resId),att=parseInt(v.attendees,10)||0;
    if(att>r.capacity)return fail(r.name+' seats '+r.capacity+'. Reduce attendees or pick a larger venue.',d);
    for(i=0;i<span.length;i++){var b=busyAt(r.id,v.date,span[i].id);
      if(b)return fail(r.name+' is not free in '+span[i].label+' on '+fmtDate(v.date)+' ('+(b.kind==='class'?'class: '+b.e.title:'event: '+b.ev.title)+').',d)}
    S.events.push({id:uid('e'),resId:r.id,date:v.date,slotIds:span.map(function(s){return s.id}),title:v.title,by:v.by,attendees:att,notes:(v.notes||'').trim(),status:canApprove()?'confirmed':'pending'});
    ui.avDate=v.date;
    return done(canApprove()?'Booked '+r.name+'.':'Request sent for approval.');
  }
}

function tryDelete(k){
  var p=k.split(':'),kind=p[0],id=p[1],n;
  if(kind==='dept'){
    n=S.resources.filter(function(r){return r.deptId===id}).length;var m=S.users.filter(function(x){return deptIdsOf(x).indexOf(id)>-1}).length,q=S.classes.filter(function(x){return x.deptId===id}).length;
    if(n||m||q)return toast('Move or delete its '+n+' venue(s), '+m+' user(s) and '+q+' year/section(s) first.',true);
    S.depts=S.depts.filter(function(x){return x.id!==id});
  } else if(kind==='cls'){
    n=S.tt.filter(function(t){return t.classId===id}).length;
    if(n)return toast('This section has '+n+' timetable class(es). Remove them first.',true);
    S.classes=S.classes.filter(function(x){return x.id!==id});
  } else if(kind==='bld'){
    n=S.resources.filter(function(r){return r.buildingId===id}).length;
    if(n)return toast(n+' venue(s) are in this building. Move them first.',true);
    S.buildings=S.buildings.filter(function(x){return x.id!==id});
  } else if(kind==='floor'){
    n=S.resources.filter(function(r){return r.floorId===id}).length;
    if(n)return toast(n+' venue(s) are on this floor. Move them first.',true);
    S.floors=S.floors.filter(function(x){return x.id!==id});
  } else if(kind==='slot'){
    n=S.tt.filter(function(t){return t.slotId===id}).length+S.events.filter(function(e){return e.slotIds.indexOf(id)>-1}).length;
    if(n)return toast('This slot is used by '+n+' class(es) or event(s). Remove them first.',true);
    S.slots=S.slots.filter(function(x){return x.id!==id});
  } else if(kind==='res'){
    n=S.tt.filter(function(t){return t.resId===id}).length+S.events.filter(function(e){return e.resId===id}).length;
    if(n)return toast('This venue has '+n+' class(es) or booking(s). Remove them first.',true);
    S.resources=S.resources.filter(function(x){return x.id!==id});
  } else if(kind==='user'){
    var u=S.users.filter(function(x){return x.id===id})[0];
    if(id===ui.userId)return toast('You cannot delete the account you are using.',true);
    if(u.role==='admin'&&S.users.filter(function(x){return x.role==='admin'}).length<2)return toast('Keep at least one administrator.',true);
    S.users=S.users.filter(function(x){return x.id!==id});
  } else if(kind==='load'){
    n=S.wplans.filter(function(r){return r.loadId===id}).length;
    if(n)return toast('This load type is used in '+n+' weekly plan(s), so it cannot be deleted.',true);
    S.loads=S.loads.filter(function(x){return x.id!==id});
  } else if(kind==='off'){S.holidays=S.holidays.filter(function(x){return x.id!==id})
  } else if(kind==='ev'){S.events=S.events.filter(function(x){return x.id!==id})}
  save();toast('Deleted.');
}

document.addEventListener('click',function(e){
  var el=e.target.closest('[data-act]');if(!el)return;
  var a=el.dataset.act,d=el.dataset;
  if(a==='closeModal'){if(el.classList.contains('overlay')&&e.target!==el)return;ui.modal=null;render();return}
  if(a!=='del')ui.confirm=null;
  switch(a){
    case 'logoutall':api('POST','/api/auth/logout-all').catch(function(){}).then(function(){signedOut()});return;
    case 'logout':api('POST','/api/auth/logout').catch(function(){}).then(function(){signedOut()});return;
    case 'syncnow':save();break;
    case 'tab':ui.tab=d.v;break;
    case 'mfclear':Object.keys(ui.mf).forEach(function(k){if(k.indexOf(d.t+'.')===0)delete ui.mf[k]});break;
    case 'seefree':ui.avDate=today;ui.avFrom=d.slot;ui.avTo=d.slot;ui.avType='';ui.avBld='';ui.avFl='';ui.avCap='';ui.tab='avail';window.scrollTo(0,0);break;
    case 'mtab':ui.mtab=d.v;break;
    case 'mode':ui.ttMode=d.v;break;
    case 'clsel':ui.clId=d.v;break;
    case 'ttres':ui.ttRes=d.v;break;
    case 'ttday':ui.ttDay=+d.v;break;
    case 'avday':ui.avDate=d.n==='0'?today:addDays(ui.avDate,+d.n);break;
    case 'togglePast':ui.evShowPast=!ui.evShowPast;break;
    case 'add':open(d.t,{});return;
    case 'edit':{var src={dept:S.depts,class:S.classes,slot:S.slots,resource:S.resources,user:S.users,building:S.buildings,floor:S.floors,load:S.loads,offday:S.holidays}[d.t].filter(function(x){return x.id===d.id})[0];open(d.t,Object.assign({},src));return}
    case 'lunch':{var ldd=deptById(d.id);if(ldd)open('lunch',{id:ldd.id,lunch:(ldd.lunchSlots||[]).slice()});return}
    case 'addbreak':{var eb=S.slots.filter(function(x){return x.isBreak})[0];open('slot',eb?Object.assign({},eb):{label:'Lunch',start:'13:15',end:'14:00',isBreak:true});return}
    case 'fullday':{var fl=slotOpts();open('fullday',{resId:ui.ttMode==='week'?ui.ttRes:'',days:[ui.ttDay],from:fl.length?fl[0][0]:'',to:fl.length?fl[fl.length-1][0]:'',title:'',faculty:'',classId:ui.lastClass||''});return}
    case 'trview':ui.trView=d.v;window.scrollTo(0,0);break;
    case 'rpcsv':rpCsv();return;
    case 'rpprint':window.print();return;
    case 'trthis':ui.trMonth=today.slice(0,7);ui.trWeek=mondayOf(today);break;
    case 'trwk':ui.trWeek=d.w;break;
    case 'trmonth':{var mm=d.n==='0'?today.slice(0,7):addD(ui.trMonth+'-15',30*(+d.n)).slice(0,7);ui.trMonth=mm;break}
    case 'calday':{var cd=d.d,cu=me();var base={dateFrom:cd,dateTo:cd,kind:d.off==='1'?'working':'off',title:d.off==='1'?'Working day':'',scope:trScope(ui.trClass)};open('offday',base);return}
    case 'trcopy':{var tg=scopeIds(document.getElementById('tr-copy').value).filter(function(x){return x&&x!==ui.trClass&&canEditTrack(x)});
      var src2=S.wplans.filter(function(r){return r.classId===ui.trClass&&r.weekStart===ui.trWeek});
      if(!tg.length){toast('Choose other sections of your department.');break}
      tg.forEach(function(cid2){src2.forEach(function(r){var t=planRow(cid2,ui.trWeek,r.loadId);if(t)t.planned=r.planned;else S.wplans.push({id:uid('w'),classId:cid2,weekStart:ui.trWeek,loadId:r.loadId,planned:r.planned,actual:null})})});
      save();toast('Plan copied to '+tg.length+' section'+(tg.length===1?'':'s')+'.');break}
    case 'trclass':ui.trClass=d.id;window.scrollTo(0,0);break;
    case 'lend':openLend(d.res);return;
    case 'book':openBook(d.res,d.from,d.to);return;
    case 'ttcell':{var ex=d.id?S.tt.filter(function(t){return t.id===d.id})[0]:null;open('tt',ex?Object.assign({},ex,{mvDay:ex.day,mvSlot:ex.slotId,moveTo:ex.resId}):{resId:d.res,day:+d.day,slotId:d.slot,title:'',faculty:'',classId:''});return}
    case 'unrel':S.releases=S.releases.filter(function(r){return r.id!==d.id});save();toast('Class restored. Its venue is in use again.');break;
    case 'gochange':{var gc=classById(d.cls);if(gc){ui.chDept=gc.deptId;ui.chClass=gc.id}ui.modal=null;ui.tab='changes';break}
    case 'ttdel':S.tt=S.tt.filter(function(t){return t.id!==d.id});S.releases=S.releases.filter(function(r){return r.ttId!==d.id});ui.modal=null;save();toast('Class removed.');break;
    case 'approve':case 'reject':{var ev=S.events.filter(function(x){return x.id===d.id})[0];ev.status=a==='approve'?'confirmed':'rejected';save();toast(a==='approve'?'Event approved.':'Request declined.');break}
    case 'del':
      if(ui.confirm===d.k){ui.confirm=null;tryDelete(d.k)}else ui.confirm=d.k;break;
  }
  render();
});
document.addEventListener('change',function(e){
  var mfs=e.target.closest('select[data-mf]');if(mfs){ui.mf[mfs.dataset.mf]=mfs.value;render();return}
  var tr=e.target.closest('[data-tr]');
  if(tr){
    var tp=tr.dataset.tr.split('|'),tcid=tp[0],tlid=tp[1],tf=tp[2],twk=tp[3]||ui.trWeek,raw=tr.value.trim(),tv;
    if(raw==='')tv=tf==='planned'?0:null;
    else{tv=Number(raw);if(!isFinite(tv)||tv<0||tv>100){toast('Enter hours between 0 and 100.',true);render();return}tv=Math.round(tv*10)/10}
    trIds(tcid).forEach(function(oneId){
      var trow=planRow(oneId,twk,tlid);
      if(!trow){if(tv===null||(tf==='planned'&&tv===0))return;trow={id:uid('w'),classId:oneId,weekStart:twk,loadId:tlid,planned:0,actual:null};S.wplans.push(trow)}
      trow[tf]=tv;
    });
    save();render();return;
  }
  var lr=e.target.closest('[data-lendref]');
  if(lr&&ui.modal&&ui.modal.type==='lend'){var lfm=lr.closest('form'),lfd={};new FormData(lfm).forEach(function(val,key){lfd[key]=val});ui.modal.vals=Object.assign({},ui.modal.vals,lfd);ui.modal.err='';render();return}
  var mv=e.target.closest('[data-mv]');
  if(mv&&ui.modal){var fm=mv.closest('form'),fd={};new FormData(fm).forEach(function(val,key){fd[key]=val});fd.mvDay=+fd.mvDay;fd.moveTo=fd.moveTo||'';ui.modal.vals=Object.assign({},ui.modal.vals,fd);ui.modal.err='';ui.modal.focused=true;render();return}
  var tk=e.target.closest('[data-trk]');
  if(tk){
    var tt=tk.dataset.trk,ton=tk.checked;
    if(tt.indexOf('d:')===0)S.classes.forEach(function(c){if(c.deptId===tt.slice(2))c.tracked=ton});
    else{var tc=classById(tt.slice(2));if(tc)tc.tracked=ton}
    save();render();return;
  }
  var al=e.target.closest('[data-alloc]');
  if(al){
    var r=resById(al.dataset.alloc),nd=al.value||null;
    var n=S.tt.filter(function(t){return t.resId===r.id}).length;
    if(r.deptId!==nd&&n){toast(r.name+' has '+n+' classes in its current department. Clear them before moving it.',true);render();return}
    r.deptId=nd;save();toast(r.name+' allocated to '+(nd?deptById(nd).code:'the central pool')+'.');render();return;
  }
  var el=e.target.closest('[data-set]');if(!el)return;
  var k=el.dataset.set;
  if(k==='avDate'&&!el.value)return;
  ui[k]=el.value;
  if(k==='chNote')return;
  if(k==='ttDept')ui.ttRes=null;
  if(k==='trDept')ui.trClass='';
  if(k==='trPick'){if(!el.value)return;ui.trWeek=mondayOf(el.value)}
  if(k==='clDept')ui.clId=null;
  if(k==='chDept')ui.chClass='';
  if(k==='chFrom'&&el.value&&ui.chTo<el.value)ui.chTo=el.value;
  render();
});
document.addEventListener('submit',function(e){
  var lf=e.target.closest('form[data-login]');
  if(lf){
    e.preventDefault();var d=new FormData(lf);
    ui.loginBusy=true;ui.loginErr='';render();
    api('POST','/api/auth/login',{email:d.get('email'),password:d.get('password')}).then(function(){ui.loginBusy=false;ui.booting=true;ui.tab='overview';render();return loadAll(false)}).catch(function(err){ui.loginBusy=false;ui.booting=false;signedOut(err.message)});
    return;
  }
  var cf=e.target.closest('form[data-chform]');
  if(cf){
    e.preventDefault();var cd=new FormData(cf);ui.chReason=cd.get('reason')||ui.chReason;ui.chNote=(cd.get('note')||'').trim();ui.chFrom=cd.get('from')||ui.chFrom;ui.chTo=cd.get('to')||ui.chTo;
    var tg=chTargets();
    if(!tg.length)return toast('No scheduled classes match.',true);
    if(tg.length>1500)return toast('That is too many at once. Choose a shorter date range.',true);
    tg.forEach(function(x){S.releases.push({id:uid('rl'),ttId:x.t.id,date:x.date,reason:ui.chReason,note:ui.chNote,by:me().name})});
    save();render();toast(tg.length+' class'+(tg.length===1?'':'es')+' released. Their venues show as free on those dates.');return;
  }
  var f=e.target.closest('form[data-form]');if(!f)return;
  e.preventDefault();
  var fd={};new FormData(f).forEach(function(val,key){fd[key]=(key in fd)?[].concat(fd[key],val):val});
  submitForm(ui.modal.type,fd);
});
document.addEventListener('input',function(e){
  var t=e.target.closest('input[data-mf]');if(!t)return;
  ui.mf[t.dataset.mf]=t.value;var id=t.id,pos=t.selectionStart;render();
  var n=document.getElementById(id);if(n){n.focus();try{n.setSelectionRange(pos,pos)}catch(x){}}
});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&ui.modal){ui.modal=null;render()}});

render();
boot();
setInterval(function(){
  if(!ui.userId||ui.modal||document.hidden||(document.activeElement&&document.activeElement.matches&&document.activeElement.matches('[data-mf]'))||sync.state==='saving'||sync.state==='loading'||sync.state==='error'||pendingOps().length)return;
  loadAll(true,true).catch(function(err){if(err.status===401)signedOut('You were signed out after a period of inactivity, or your account changed. Please sign in again.')});
},45000);
})();
