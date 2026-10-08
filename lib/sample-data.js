// Demo campus used by `npm run db:seed-demo` and `npm run dev`.
const addDays = (s, n) => {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function sampleData(today){
  var depts=[
    {id:'d_cse',name:'Computer Science & Engineering',code:'CSE',h:205},
    {id:'d_ece',name:'Electronics & Communication',code:'ECE',h:150},
    {id:'d_me',name:'Mechanical Engineering',code:'ME',h:28},
    {id:'d_ce',name:'Civil Engineering',code:'CE',h:50},
    {id:'d_mba',name:'Management Studies',code:'MBA',h:320}];
  var slots=[
    {id:'s1',label:'P1',start:'09:00',end:'10:00'},{id:'s2',label:'P2',start:'10:00',end:'11:00'},
    {id:'s3',label:'P3',start:'11:15',end:'12:15'},{id:'s4',label:'P4',start:'12:15',end:'13:15'},
    {id:'s5',label:'P5',start:'14:00',end:'15:00'},{id:'s6',label:'P6',start:'15:00',end:'16:00'},
    {id:'s7',label:'P7',start:'16:00',end:'17:00'},{id:'s8',label:'Evening',start:'17:00',end:'19:00'},
    {id:'s9',label:'Lunch',start:'13:15',end:'14:00',isBreak:true}];
  var buildings=[{id:'b1',name:'Academic Block A'},{id:'b2',name:'Academic Block B'},{id:'b3',name:'Academic Block C'},{id:'b4',name:'Admin Block'},{id:'b5',name:'Central Campus'},{id:'b6',name:'Library Block'}];
  var floors=[{id:'f0',name:'Ground floor',level:0},{id:'f1',name:'1st floor',level:1},{id:'f2',name:'2nd floor',level:2},{id:'f3',name:'3rd floor',level:3}];
  var R=function(id,name,type,bId,fId,cap,eq,d){return {id:id,name:name,type:type,buildingId:bId,floorId:fId,capacity:cap,equipment:eq,deptId:d}};
  var resources=[
    R('r1','LT-101','Lecture theatre','b1','f0',120,'Projector, PA system','d_cse'),
    R('r2','LT-102','Lecture theatre','b1','f1',90,'Projector','d_ece'),
    R('r3','LT-201','Lecture theatre','b2','f0',90,'Projector','d_me'),
    R('r4','LT-202','Lecture theatre','b2','f1',60,'Smart board','d_ce'),
    R('r5','LT-301','Lecture theatre','b3','f0',120,'Projector, podium mic','d_mba'),
    R('r6','LT-103','Lecture theatre','b1','f0',150,'Projector, PA system, lecture capture',null),
    R('r7','CS Lab 1','Computer lab','b1','f2',60,'60 PCs, projector','d_cse'),
    R('r8','CS Lab 2','Computer lab','b1','f2',60,'60 PCs, projector','d_cse'),
    R('r9','Networking Lab','Computer lab','b1','f3',40,'40 PCs, routers, switches','d_cse'),
    R('r10','Electronics Computing Lab','Computer lab','b2','f0',40,'40 PCs, simulation software','d_ece'),
    R('r11','Management Analytics Lab','Computer lab','b3','f1',50,'50 PCs, analytics suite','d_mba'),
    R('r12','Seminar Hall A','Seminar hall','b4','f0',150,'Projector, PA system, AC',null),
    R('r13','Seminar Hall B','Seminar hall','b3','f1',80,'Projector, AC','d_mba'),
    R('r14','Main Auditorium','Auditorium','b5','f0',800,'Stage, lighting, PA system, AC',null),
    R('r15','Mini Auditorium','Auditorium','b6','f0',250,'Stage, projector, AC',null)];
  var users=[
    {id:'u1',name:'Meera Iyer',email:'meera.iyer@college.example',role:'admin',deptId:null},
    {id:'u2',name:'Dr. R. Sharma',email:'hod.cse@college.example',role:'hod',deptId:'d_cse'},
    {id:'u3',name:'Dr. A. Khan',email:'hod.ece@college.example',role:'hod',deptId:'d_ece'},
    {id:'u4',name:'Prof. S. Patil',email:'hod.me@college.example',role:'hod',deptId:'d_me'},
    {id:'u5',name:'Dr. N. Gupta',email:'hod.ce@college.example',role:'hod',deptId:'d_ce'},
    {id:'u6',name:'Dr. P. Menon',email:'hod.mba@college.example',role:'hod',deptId:'d_mba'},
    {id:'u7',name:'Dr. Vikram Rao',email:'principal@college.example',role:'head',deptId:null},
    {id:'u8',name:'Anita Desai (Training & Placement)',email:'placement@college.example',role:'stakeholder',deptId:null},
    {id:'u9',name:'Rohan Verma (Student Council)',email:'council@college.example',role:'stakeholder',deptId:null}];
  var SUBJ={d_cse:['Data Structures','Operating Systems','Database Systems','Computer Networks','Machine Learning','Software Engineering'],
    d_ece:['Signals & Systems','Analog Circuits','Digital Electronics','VLSI Design','Communication Systems','Embedded Systems'],
    d_me:['Thermodynamics','Fluid Mechanics','Machine Design','Heat Transfer','Manufacturing Processes','Engineering Mechanics'],
    d_ce:['Structural Analysis','Geotechnical Engineering','Surveying','Concrete Technology','Transportation Engineering','Hydrology'],
    d_mba:['Marketing Management','Financial Accounting','Business Analytics','Organisational Behaviour','Operations Management','Strategic Management']};
  var FAC={d_cse:['Dr. R. Sharma','Prof. K. Nair','Dr. L. Banerjee','Prof. T. Reddy','Dr. S. Joshi','Prof. M. Kulkarni'],
    d_ece:['Dr. A. Khan','Prof. V. Rao','Dr. H. Mishra','Prof. D. Pillai','Dr. G. Thomas','Prof. B. Sen'],
    d_me:['Prof. S. Patil','Dr. C. Bhatt','Prof. J. Chavan','Dr. U. Singh','Prof. A. Deshmukh','Dr. F. Ansari'],
    d_ce:['Dr. N. Gupta','Prof. P. Yadav','Dr. O. Saxena','Prof. W. Dutta','Dr. I. Kapoor','Prof. Y. Rane'],
    d_mba:['Dr. P. Menon','Prof. E. Fernandes','Dr. Q. Malhotra','Prof. X. Arora','Dr. Z. Hegde','Prof. T. Bose']};
  var classes=[];
  depts.forEach(function(d){(d.id==='d_mba'?[1,2]:[1,2,3,4]).forEach(function(y){['A','B'].forEach(function(sec){classes.push({id:'c_'+d.code.toLowerCase()+'_'+y+sec.toLowerCase(),deptId:d.id,year:y,section:sec,strength:60})})})});
  var tt=[],n=0,usedF={},usedC={};
  resources.forEach(function(r,ri){
    if(!r.deptId) return;
    var d=r.deptId,code=depts.filter(function(x){return x.id===d})[0].code,lab=r.type==='Computer lab';
    for(var day=0;day<6;day++)for(var si=0;si<7;si++){
      if(day===5&&si>3) continue;
      if((ri*7+day*5+si*3)%10>=(lab?5:6)) continue;
      var f=null,k;
      for(k=0;k<6;k++){var c=FAC[d][(ri+day+si+k)%6];if(!usedF[day+'-'+si+'-'+c]){f=c;break}}
      var dc=classes.filter(function(x){return x.deptId===d}),cls=dc[(ri+si+day)%dc.length].id;
      if(!f||usedC[day+'-'+si+'-'+cls]) continue;
      usedF[day+'-'+si+'-'+f]=1;usedC[day+'-'+si+'-'+cls]=1;
      var sub=SUBJ[d][(ri+day*2+si)%6];
      tt.push({id:'t'+(n++),resId:r.id,day:day,slotId:slots[si].id,title:lab?sub+' Lab':sub,faculty:f,classId:cls});
    }
  });
  var events=[
    {id:'e1',resId:'r14',date:addDays(today,1),slotIds:['s5','s6'],title:"Freshers' Welcome",by:'Rohan Verma (Student Council)',attendees:600,notes:'',status:'confirmed'},
    {id:'e2',resId:'r12',date:addDays(today,2),slotIds:['s3','s4'],title:'Industry talk: Cloud careers',by:'Anita Desai (Training & Placement)',attendees:120,notes:'Two external speakers',status:'pending'},
    {id:'e3',resId:'r6',date:addDays(today,3),slotIds:['s1','s2'],title:'Guest lecture on research funding',by:'Dr. Vikram Rao',attendees:140,notes:'',status:'confirmed'}];
  return {depts:depts,classes:classes,slots:slots,buildings:buildings,floors:floors,resources:resources,users:users,tt:tt,events:events};
}

