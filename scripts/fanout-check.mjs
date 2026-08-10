const FAN_OUT=[[/\bfor\b[\s\S]{0,120}\bdo\b[\s\S]{0,200}\bssh\b/,"循环遍历主机执行 ssh"],
[/\bwhile\b[\s\S]{0,120}\bread\b[\s\S]{0,200}\bssh\b/,"按行读取主机列表"],
[/\bxargs\b[^;&|]*\bssh\b/,"xargs 批量 ssh"],[/\bparallel\b[^;&|]*\bssh\b/,"parallel 批量 ssh"],
[/\b(pssh|parallel-ssh|clush|pdsh|fabric|fab)\b/,"并行 ssh 工具"],[/\bansible(-playbook)?\b/,"ansible"],
[/\bkubectl\b[^;&|]*\b(delete|drain|cordon)\b/,"kubectl 批量"],[/\bdocker\b[^;&|]*\b(prune|kill|rm)\b[^;&|]*(-a|--all)\b/,"docker 全量清理"]];
const REMOTE=[[/\bsystemctl\b[^;&|]*\b(stop|disable|mask)\b/,"停用服务"],[/\b(reboot|shutdown|poweroff|halt)\b/,"重启/关机"],
[/\biptables\b[^;&|]*\s-(F|X|Z)\b/,"清空防火墙"],[/\bnft\b[^;&|]*\bflush\b/,"清空 nftables"],[/\bufw\b[^;&|]*\bdisable\b/,"关闭 ufw"],
[/\bcrontab\b[^;&|]*\s-r\b/,"删除定时任务"],[/\b(userdel|usermod|passwd)\b/,"修改账户"],[/\b(truncate|shred)\b/,"截断/擦除"],
[/>\s*\/etc\//,"覆盖 /etc"],[/\bwg-quick\b[^;&|]*\bdown\b/,"关闭 WireGuard"]];
const check=(c)=>{const r=[];for(const[p,d]of FAN_OUT)if(p.test(c))r.push(d);
if(r.length===0&&(c.match(/\bssh\b/g)??[]).length>=3)r.push("多次 ssh");
if(/\bssh\b/.test(c)||r.length>0)for(const[p,d]of REMOTE)if(p.test(c))r.push(d);
return [...new Set(r)];};
const cases=[
["for h in $(cat hosts); do ssh $h 'systemctl stop nginx'; done","批量停服务",true],
["cat hosts | xargs -P20 -I{} ssh {} 'reboot'","并发重启全部",true],
["ansible all -m shell -a 'iptables -F'","ansible 清防火墙",true],
["ssh jp1 'crontab -r'","远程删定时任务",true],
["for h in $(cat hosts); do ssh $h 'echo > /etc/resolv.conf'; done","批量清 DNS",true],
["ssh de1 'wg-quick down wg0'","远程关 WireGuard",true],
["ssh hk1 'hostname -I'","单机查 IP（正常workflow）",false],
["ssh jp2 'curl -s ifconfig.me'","单机查出口IP（正常workflow）",false],
["ls -la ./src","本地 ls",false],
["cat /etc/hostname","本地 cat",false],
["ssh us1 'df -h && free -m'","单机查磁盘内存",false],
];
let fail=0;
for(const[c,desc,want]of cases){const r=check(c);const got=r.length>0;const ok=got===want;if(!ok)fail++;
console.log(`  ${ok?"✓":"✗"} ${want?"应拦":"应放行"} | ${desc.padEnd(22)} ${got?"→ "+r.join(" + "):"→ 放行"}`);}
console.log(fail===0?"\n扇出防护验证通过":`\n${fail} 处不符`);
process.exit(fail===0?0:1);
