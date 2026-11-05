const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const quoted=value=>"'"+String(value).replaceAll("'","''")+"'";
function fixture(t){
  const base=fs.realpathSync.native(os.tmpdir()),root=fs.mkdtempSync(path.join(base,'kh-enrollment-links-'));
  t.after(()=>{assert.equal(path.dirname(root),base);assert.ok(path.basename(root).startsWith('kh-enrollment-links-'));fs.rmSync(root,{recursive:true,force:true});});
  for(const relative of ['shared','profiles/primary','profiles/account-test'])fs.mkdirSync(path.join(root,relative),{recursive:true});
  const link=path.join(root,'official');
  function run(body){const file=path.join(root,'probe.ps1');fs.writeFileSync(file,'$ErrorActionPreference="Stop"\nImport-Module '+quoted(path.join(__dirname,'onboarding-links.psm1'))+' -Force\n$root='+quoted(root)+'\n$link='+quoted(link)+'\n'+body);return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',file],{windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']});}
  return{root,link,run,args:'-Root $root -Link $link -To account-test -KnownAliases @(\'primary\',\'account-test\')'};
}
test('enrollment creates a fresh linked login folder and return restores initial absence',{skip:process.platform!=='win32'},t=>{
  const f=fixture(t);f.run('Set-KhEnrollmentLink '+f.args+' | Out-Null');assert.equal(fs.realpathSync(f.link),path.join(f.root,'profiles/account-test'));
  f.run('Restore-KhEnrollmentLink '+f.args+' | Out-Null');assert.equal(fs.existsSync(f.link),false);assert.ok(fs.existsSync(path.join(f.root,'profiles/account-test')));
});
test('a dangling original Junction is retained and restored without recreating deleted data',{skip:process.platform!=='win32'},t=>{
  const f=fixture(t),original=path.join(f.root,'profiles/primary');fs.symlinkSync(original,f.link,'junction');fs.rmdirSync(original);
  f.run('Set-KhEnrollmentLink '+f.args+' | Out-Null');assert.equal(fs.realpathSync(f.link),path.join(f.root,'profiles/account-test'));assert.equal(fs.existsSync(original),false);
  f.run('Restore-KhEnrollmentLink '+f.args+' | Out-Null');assert.equal(fs.lstatSync(f.link).isSymbolicLink(),true);assert.equal(path.resolve(fs.readlinkSync(f.link)),original);assert.equal(fs.existsSync(original),false);
});
test('a failure in the link gap restores the original and retains both account directories',{skip:process.platform!=='win32'},t=>{
  const f=fixture(t),original=path.join(f.root,'profiles/primary');fs.symlinkSync(original,f.link,'junction');
  assert.throws(()=>f.run('Set-KhEnrollmentLink '+f.args+' -AfterPhase {param($phase) if($phase -eq "original_preserved"){throw "synthetic failure"}} | Out-Null'));
  assert.equal(fs.realpathSync(f.link),original);assert.equal(fs.existsSync(f.link+'.khlink-enroll-next'),false);assert.equal(fs.existsSync(f.link+'.khlink-enroll-previous'),false);
});
test('a crash after replacement can resume the same pending account and commit',{skip:process.platform!=='win32'},t=>{
  const f=fixture(t),original=path.join(f.root,'profiles/primary');fs.symlinkSync(original,f.link,'junction');
  assert.throws(()=>f.run('Set-KhEnrollmentLink '+f.args+' -AfterPhase {param($phase) if($phase -eq "replacement_verified"){throw "synthetic crash"}} | Out-Null'));
  f.run('Set-KhEnrollmentLink '+f.args+' | Out-Null\nComplete-KhEnrollmentLink '+f.args);
  assert.equal(fs.realpathSync(f.link),path.join(f.root,'profiles/account-test'));assert.ok(fs.existsSync(original));assert.equal(fs.existsSync(f.link+'.khlink-enroll-previous'),false);
});
test('an unknown retained directory is never deleted or replaced',{skip:process.platform!=='win32'},t=>{
  const f=fixture(t),original=path.join(f.root,'profiles/primary');fs.symlinkSync(original,f.link,'junction');
  fs.mkdirSync(f.link+'.khlink-enroll-next');fs.writeFileSync(path.join(f.link+'.khlink-enroll-next','preserve'),'original');
  assert.throws(()=>f.run('Set-KhEnrollmentLink '+f.args+' | Out-Null'));assert.equal(fs.realpathSync(f.link),original);assert.equal(fs.readFileSync(path.join(f.link+'.khlink-enroll-next','preserve'),'utf8'),'original');
});
