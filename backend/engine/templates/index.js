const fs=require("fs");const path=require("path");
const names=["Obby", "Platformer", "Team Battle", "BedWars", "Survival", "Racing", "Tycoon", "Simulator", "RPG", "Adventure", "Horror", "Arena", "Empty World"];
function load(name){
  const map={};
  for (const n of names) map[n]=n.replace(/ /g,'_')+'.json';
  const file=map[name]||map['Empty World'];
  const p=path.join(__dirname,file);
  return JSON.parse(fs.readFileSync(p,'utf8'));
}
function list(){return names.slice();}
module.exports={load,list,names};
