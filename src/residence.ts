import { all, one, run, tx, audit, id } from './store.ts';
import { demand } from './domain.ts';

export async function residenceLocations(admin=false) {
  const cityUsage=admin?',(SELECT COUNT(*) FROM profiles p WHERE p.residence_city_id=c.id) AS used':'';
  const districtUsage=admin?',(SELECT COUNT(*) FROM profiles p WHERE p.residence_district_id=d.id) AS used':'';
  return {
    cities:await all(`SELECT c.*${cityUsage} FROM residence_cities c ORDER BY sort_order,id`),
    districts:await all(`SELECT d.*${districtUsage} FROM residence_districts d ORDER BY sort_order,id`)
  };
}

export async function resolveResidence(input:any,current:any) {
  if (!Object.hasOwn(input,'residenceCityId')&&!Object.hasOwn(input,'residenceDistrictId')) {
    demand(!Object.hasOwn(input,'region')||input.region===current.region,422,'RESIDENCE_SELECTION','請使用居住縣市與居住地區選單。');
    return {cityId:current.residence_city_id,districtId:current.residence_district_id,region:current.region};
  }
  demand(['residenceCityId','residenceDistrictId'].every(key=>input[key]===undefined||input[key]===null||typeof input[key]==='string'),422,'RESIDENCE_SELECTION','請使用有效的縣市地區選項。');
  const cityId=typeof input.residenceCityId==='string'?input.residenceCityId.trim()||null:null;
  const districtId=typeof input.residenceDistrictId==='string'?input.residenceDistrictId.trim()||null:null;
  if (!cityId&&!districtId&&!current.residence_city_id) return {cityId:null,districtId:null,region:current.region};
  demand(!districtId||cityId,422,'RESIDENCE_CITY','請先選擇居住縣市。');
  const city=cityId?await one('SELECT * FROM residence_cities WHERE id=?',cityId):null;
  demand(!cityId||(city&&(city.active||city.id===current.residence_city_id)),422,'RESIDENCE_CITY','居住縣市不存在或已停用，請重新選擇。');
  demand(!city||city.active||!districtId||districtId===current.residence_district_id,422,'RESIDENCE_CITY','此縣市已停用，請選擇其他居住縣市。');
  const district=districtId?await one('SELECT * FROM residence_districts WHERE id=? AND city_id=?',districtId,cityId):null;
  demand(!districtId||(district&&(district.active||district.id===current.residence_district_id)),422,'RESIDENCE_DISTRICT','請選擇該縣市所屬的居住地區。');
  return {cityId,districtId,region:city?.name??''};
}

export async function saveResidenceLocation(kind:'cities'|'districts',key:string|undefined,input:any,actor:string) {
  const table=kind==='cities'?'residence_cities':'residence_districts';
  return tx(async()=>{
    const current=key?await one(`SELECT * FROM ${table} WHERE id=?`,key):null;
    demand(!key||current,404,'LOCATION_NOT_FOUND','找不到這筆縣市地區資料。');
    const name=typeof input.name==='string'?input.name.trim().replaceAll('台','臺'):'';
    const pattern=kind==='cities'?/^[\u3400-\u9fff]+[縣市]$/:/^[\u3400-\u9fff]+[鄉鎮市區]$/;
    demand(name.length<=20&&pattern.test(name),422,'LOCATION_NAME',kind==='cities'?'請填寫台灣縣市名稱（以縣或市結尾）。':'請填寫鄉鎮市區名稱（以鄉、鎮、市或區結尾）。');
    demand(Number.isInteger(input.sortOrder)&&input.sortOrder>=0&&input.sortOrder<=9999&&typeof input.active==='boolean',422,'LOCATION_FIELDS','請填寫 0 至 9999 的排序及啟用狀態。');
    const cityId=kind==='districts'?(current?.city_id??input.cityId):null;
    if (kind==='districts') demand(typeof cityId==='string'&&cityId.length>0,422,'LOCATION_CITY','請先選擇所屬縣市。');
    if (kind==='districts') demand(await one('SELECT id FROM residence_cities WHERE id=?',cityId),422,'LOCATION_CITY','請先選擇所屬縣市。');
    const duplicate=kind==='cities'?await one('SELECT id FROM residence_cities WHERE name=? AND id<>?',name,key??''):
      await one('SELECT id FROM residence_districts WHERE city_id=? AND name=? AND id<>?',cityId,name,key??'');
    demand(!duplicate,409,'LOCATION_DUPLICATE','已有相同名稱，請編輯既有資料。');
    const locationId=key??id();
    if (current) await run(`UPDATE ${table} SET name=?,sort_order=?,active=? WHERE id=?`,name,input.sortOrder,Number(input.active),locationId);
    else if (kind==='cities') await run('INSERT INTO residence_cities VALUES (?,?,?,?)',locationId,name,input.sortOrder,Number(input.active));
    else await run('INSERT INTO residence_districts VALUES (?,?,?,?,?)',locationId,cityId,name,input.sortOrder,Number(input.active));
    if (kind==='cities'&&current?.name!==name) await run('UPDATE profiles SET region=? WHERE residence_city_id=?',name,locationId);
    await audit(actor,current?'residence.update':'residence.create',locationId,{kind,name,cityId,sortOrder:input.sortOrder,active:input.active});
    return {id:locationId};
  });
}
