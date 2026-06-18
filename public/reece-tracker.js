/*! reece-tracker.js — first-party visitor tracking for Reece (main site, GHL pages, Weakest Point LP) */
(function(){
  "use strict";
  var tag=document.querySelector("script[data-reece-tracker]");
  var CFG={
    url:(tag&&tag.getAttribute("data-collector"))||"",
    cookie:(tag&&tag.getAttribute("data-cookie"))||"_reece_vid",
    days:parseInt((tag&&tag.getAttribute("data-cookie-days"))||"730",10),
    sisters:((tag&&tag.getAttribute("data-sister-domains"))||"reecewindows.com,getreecewindows.com").split(",").map(function(s){return s.trim().toLowerCase();}),
    spa:(tag&&tag.getAttribute("data-track-spa"))!=="false"
  };
  if(!CFG.url){return;}
  function uuid(){return (window.crypto&&crypto.randomUUID)?crypto.randomUUID():"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var r=Math.random()*16|0,v=c==="x"?r:(r&0x3|0x8);return v.toString(16);});}
  function root(){var p=location.hostname.split(".");return p.length<=2?location.hostname:p.slice(-2).join(".");}
  function setC(n,v,d){var e=new Date();e.setTime(e.getTime()+d*864e5);document.cookie=n+"="+v+";expires="+e.toUTCString()+";path=/;domain=."+root()+";SameSite=Lax"+(location.protocol==="https:"?";Secure":"");}
  function getC(n){var m=document.cookie.match("(^|;)\\s*"+n+"\\s*=\\s*([^;]+)");return m?decodeURIComponent(m.pop()):null;}
  function qp(n){try{return new URLSearchParams(location.search).get(n);}catch(e){return null;}}
  function sister(h){h=(h||"").toLowerCase();return CFG.sisters.some(function(d){return h===d||h.indexOf("."+d)!==-1;});}
  var sid=getC("_reece_sid")||uuid(); setC("_reece_sid",sid,1);
  var inV=qp("vid"),vid=getC(CFG.cookie),alias=null;
  if(inV){ if(!vid){vid=inV;} else if(vid!==inV){alias=inV;} }
  if(!vid){vid=uuid();}
  setC(CFG.cookie,vid,CFG.days);
  var cid=qp("cid");
  function base(type){
    var raw={url:location.href,title:document.title,referrer:document.referrer||null,
      utm_medium:qp("utm_medium"),utm_campaign:qp("utm_campaign"),utm_term:qp("utm_term"),utm_content:qp("utm_content"),
      gclid:qp("gclid"),msclkid:qp("msclkid"),
      screen:(screen.width||0)+"x"+(screen.height||0),
      tz:(window.Intl&&Intl.DateTimeFormat)?Intl.DateTimeFormat().resolvedOptions().timeZone:null,
      ts:new Date().toISOString()};
    if(alias){raw.alias_id=alias;}
    if(cid){raw.cid=cid;}
    return {event_type:type,visitor_id:vid,session_id:sid,page_path:location.pathname,
      utm_source:qp("utm_source"),fbclid:qp("fbclid"),
      identity_email:null,identity_phone:null,raw:raw};
  }
  function send(p){try{var b=JSON.stringify(p);var blob=new Blob([b],{type:"text/plain"});
    if(navigator.sendBeacon){navigator.sendBeacon(CFG.url,blob);}
    else{fetch(CFG.url,{method:"POST",keepalive:true,headers:{"Content-Type":"text/plain"},body:b}).catch(function(){});}
  }catch(e){} alias=null;}
  document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var d;try{d=new URL(a.href,location.href);}catch(x){return;}if(d.hostname.toLowerCase()===location.hostname.toLowerCase())return;if(!sister(d.hostname))return;if(!d.searchParams.get("vid")){d.searchParams.set("vid",vid);a.href=d.toString();}},true);
  var last=null;function pv(){if(location.pathname===last)return;last=location.pathname;send(base("pageview"));}
  if(CFG.spa&&window.history&&history.pushState){var ps=history.pushState,rs=history.replaceState;history.pushState=function(){ps.apply(this,arguments);setTimeout(pv,0);};history.replaceState=function(){rs.apply(this,arguments);setTimeout(pv,0);};window.addEventListener("popstate",function(){setTimeout(pv,0);});}
  window.ReeceTrack={
    getVisitorId:function(){return vid;},
    identify:function(t){t=t||{};var p=base("identify");p.identity_email=t.email?String(t.email).trim().toLowerCase():null;p.identity_phone=t.phone?String(t.phone):null;if(t.name){p.raw.name=String(t.name).trim();}send(p);},
    track:function(n,props){var p=base("event");p.raw.event_name=n||"event";p.raw.props=props||{};send(p);}
  };
  if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",pv);}else{pv();}
})();
