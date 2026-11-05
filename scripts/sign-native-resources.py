import os,sys,subprocess
magic={bytes.fromhex(x) for x in ['feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca']}
for directory,_,files in os.walk(sys.argv[1]):
 for name in files:
  p=os.path.join(directory,name)
  if os.path.islink(p): continue
  with open(p,'rb') as stream: native=stream.read(4) in magic
  if native: subprocess.run(['codesign','--force','--sign','-','--timestamp=none','--entitlements','src-tauri/entitlements.mac.plist',p],check=True)
