let obj = JSON.parse($response.body);

function clean(arr){
  if(!Array.isArray(arr)) return arr;
  return arr.filter(i=>{
    if(!i) return false;

    if(i.type === "feed_advert") return false;
    if(i.target && i.target.type === "advert") return false;
    if(i.ad_info) return false;

    return true;
  });
}

if(obj.data){
  obj.data = clean(obj.data);
}

$done({body:JSON.stringify(obj)});