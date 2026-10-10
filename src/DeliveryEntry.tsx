import { useMemo, useState } from "react";
import DeliveryShift from "./DeliveryShift";
import { createOfflineDeliveryClient } from "./offline/client";
import type { DeliveryManifestV1 } from "./offline/contracts";
export default function DeliveryEntry({userId,onLogout}:{userId?:string;onLogout:()=>Promise<void>}){
 const client=useMemo(()=>createOfflineDeliveryClient(),[]),[manifest,setManifest]=useState<DeliveryManifestV1>();
 async function refresh(){
  const profile=client.activeProfile;
  const key=`bombo-delivery-device:${userId??profile?.userId??"pending"}`;
  let deviceId=profile&&(!userId||profile.userId===userId)?profile.deviceId:localStorage.getItem(key);
  if(!deviceId){deviceId=crypto.randomUUID();localStorage.setItem(key,deviceId);}
  let response=await fetch(`/api/delivery/devices/current?deviceId=${encodeURIComponent(deviceId)}`,{credentials:"include",cache:"no-store"});
  if(response.status===404){
   response=await fetch("/api/operations/commands",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({schemaVersion:1,requestId:crypto.randomUUID(),targetId:deviceId,expectedVersion:0,occurredAt:new Date().toISOString(),command:"DeviceRegistered",data:{name:"Teléfono de reparto"}})});
   if(!response.ok)throw new Error((await response.json()).error??"No se pudo registrar el dispositivo");
  }else if(!response.ok)throw new Error((await response.json()).error??"Ingresá online para preparar el turno");
  response=await fetch(`/api/delivery/manifests/current?deviceId=${encodeURIComponent(deviceId)}`,{credentials:"include",cache:"no-store"});
  if(!response.ok){const body=await response.json();throw new Error(body.code==="DEVICE_NOT_CERTIFIED"?`El responsable debe comprobar almacenamiento y reinicio de este teléfono antes del turno. Dispositivo: ${deviceId}`:body.error??body.message??"No se pudo preparar el turno");}
  const fresh=await response.json() as DeliveryManifestV1;setManifest(fresh);return fresh;
 }
 return <DeliveryShift client={client} manifest={manifest} onRefreshManifest={refresh} onLogout={onLogout}/>;
}
