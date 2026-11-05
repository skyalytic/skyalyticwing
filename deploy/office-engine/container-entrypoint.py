import os, re, urllib.parse, xml.etree.ElementTree as E
for key in ('WING_WOPI_ORIGIN', 'WING_FRAME_ORIGIN'):
    u = urllib.parse.urlsplit(os.environ.get(key, ''))
    if u.scheme not in ('http', 'https') or not u.hostname or u.username or u.password or u.path not in ('', '/') or u.query or u.fragment:
        raise SystemExit('Invalid Office origin: ' + key)
path = '/etc/coolwsd/coolwsd.xml'
tree = E.parse(path); root = tree.getroot()
listen = os.environ.get('WING_OFFICE_LISTEN', 'any')
if listen not in ('any', 'loopback'): raise SystemExit('Invalid listen mode')
settings = {'net/listen':listen,'net/proto':'IPv4','ssl/enable':'false','ssl/termination':'false',
            'logging/level':'warning','net/frame_ancestors':os.environ['WING_FRAME_ORIGIN']}
for key, value in settings.items():
    node = root.find(key)
    if node is not None: node.text = value
groups = root.find('storage/wopi/alias_groups')
if groups is None: raise SystemExit('Unsupported Office WOPI schema')
groups.clear(); groups.set('mode','groups')
group = E.SubElement(groups,'group')
E.SubElement(group,'host',{'allow':'true'}).text = os.environ['WING_WOPI_ORIGIN']
tree.write(path,encoding='UTF-8',xml_declaration=True)
os.execvp('runuser',['runuser','-u','cool','--','/usr/bin/coolwsd','--config-file=/etc/coolwsd/coolwsd.xml',
    '--o:server_name=127.0.0.1:19980','--o:sys_template_path=/opt/cool/systemplate',
    '--o:child_root_path=/opt/cool/child-roots','--o:file_server_root_path=/usr/share/coolwsd','--o:cache_files.path=/opt/cool/cache'])
