/* Wing UNO adapter for the embedded LibreOffice engine, using the MIT ZetaJS API. */
'use strict';
Module.zetajs.then((z) => {
  const css = z.uno.com.sun.star,
    context = z.getUnoComponentContext(),
    desktop = css.frame.Desktop.create(context);
  let model,
    filename,
    listener,
    interceptor,
    contextMenuInterceptor,
    menuBranch,
    commandDescriptions;
  const commandProperties = new Map();
  function commandInfo(url) {
    if (!commandProperties.has(url)) {
      try {
        commandProperties.set(
          url,
          Object.fromEntries(commandDescriptions.getByName(url).map((p) => [p.Name, p.Value])),
        );
      } catch {
        return {};
      }
    }
    return commandProperties.get(url);
  }
  function commandTarget(url) {
    return commandInfo(url).TargetURL || url;
  }
  const send = (data) => z.mainPort.postMessage(data);
  function property(Name, Value) {
    return new css.beans.PropertyValue({ Name, Value });
  }
  z.mainPort.onmessage = (e) => {
    const d = e.data;
    try {
      if (d.cmd === 'open') {
        filename = d.filename;
        const ext = filename.split('.').pop().toLowerCase();
        const fileUrl = 'file:///tmp/wing/' + encodeURIComponent(filename);
        const kind = ['xls', 'xlsx', 'ods'].includes(ext)
          ? 'scalc'
          : ['ppt', 'pptx', 'odp'].includes(ext)
            ? 'simpress'
            : 'swriter';
        model = desktop.loadComponentFromURL(
          d.blank ? 'private:factory/' + kind : fileUrl,
          '_default',
          0,
          [property('MacroExecutionMode', 0), property('UpdateDocMode', 0)],
        );
        if (!model) throw Error('无法打开此文档');
        if (d.blank) {
          const filters = {
            docx: 'Office Open XML Text',
            xlsx: 'Calc MS Excel 2007 XML',
            pptx: 'Impress MS PowerPoint 2007 XML',
            doc: 'MS Word 97',
            xls: 'MS Excel 97',
            ppt: 'MS PowerPoint 97',
            odt: 'writer8',
            ods: 'calc8',
            odp: 'impress8',
          };
          model.storeAsURL(fileUrl, [
            property('FilterName', filters[ext]),
            property('Overwrite', true),
          ]);
        }
        model.getCurrentController().getFrame().getContainerWindow().FullScreen = true;
        listener = z.unoObject(['com.sun.star.util.XModifyListener'], {
          modified: () => {
            if (model.isModified()) send({ cmd: 'changed' });
          },
          disposing: () => {},
        });
        model.addModifyListener(listener);
        const frame = model.getCurrentController().getFrame();
        let slave, master;
        const hostCommands = [
          '.uno:Save',
          '.uno:SaveAs',
          '.uno:SaveACopy',
          '.uno:Open',
          '.uno:OpenFromWriter',
          '.uno:NewDoc',
          '.uno:AddDirect',
          '.uno:CloseDoc',
          '.uno:Quit',
        ];
        const dispatch = z.unoObject(['com.sun.star.frame.XDispatch'], {
          dispatch: (url) => send({ cmd: 'menu-action', url: url.Complete }),
          addStatusListener: (l, url) =>
            l.statusChanged(
              new css.frame.FeatureStateEvent({
                Source: dispatch,
                FeatureURL: url,
                IsEnabled: true,
                Requery: false,
                State: true,
              }),
            ),
          removeStatusListener: () => {},
        });
        interceptor = z.unoObject(['com.sun.star.frame.XDispatchProviderInterceptor'], {
          queryDispatch: (url, target, flags) =>
            hostCommands.includes(url.Complete) || url.Complete.startsWith('private:factory/')
              ? dispatch
              : slave?.queryDispatch(url, target, flags) || null,
          queryDispatches: (requests) =>
            requests.map((r) =>
              interceptor.queryDispatch(r.FeatureURL, r.FrameName, r.SearchFlags),
            ),
          getSlaveDispatchProvider: () => slave || null,
          setSlaveDispatchProvider: (p) => {
            slave = p;
          },
          getMasterDispatchProvider: () => master || null,
          setMasterDispatchProvider: (p) => {
            master = p;
          },
        });
        frame.registerDispatchProviderInterceptor(interceptor);
        const commandLabels = new Map();
        // Draw the engine's context-specific commands with the host's CJK font.
        contextMenuInterceptor = z.unoObject(['com.sun.star.ui.XContextMenuInterceptor'], {
          notifyContextMenuExecute: (event) => {
            function items(container) {
              const result = [];
              for (let i = 0; i < container.getCount(); i++) {
                const entry = container.getByIndex(i);
                if (entry.supportsService('com.sun.star.ui.ActionTriggerSeparator')) {
                  result.push({ label: '' });
                  continue;
                }
                const sub = entry.getPropertyValue('SubContainer');
                const url = entry.getPropertyValue('CommandURL');
                const children = sub ? items(sub) : [];
                if (sub && !children.length) continue;
                if (!sub && url?.startsWith('.uno:')) {
                  const parsed = { val: new css.util.URL({ Complete: commandTarget(url) }) };
                  css.util.URLTransformer.create(context).parseStrict(parsed);
                  const feature = parsed.val;
                  const provider = frame.queryDispatch(feature, '', 0);
                  if (!provider) continue;
                  let enabled = false;
                  const status = z.unoObject(['com.sun.star.frame.XStatusListener'], {
                    statusChanged: (event) => {
                      enabled = event.IsEnabled;
                    },
                    disposing: () => {},
                  });
                  provider.addStatusListener(status, feature);
                  provider.removeStatusListener(status, feature);
                  if (!enabled) continue;
                }
                let label = entry.getPropertyValue('Text');
                if (!label && url) {
                  try {
                    label = commandLabels.get(url);
                    if (!label) {
                      const properties = commandInfo(url);
                      label = properties.ContextLabel || properties.Label || properties.Name;
                      commandLabels.set(url, label);
                    }
                  } catch {}
                }
                if (!label) continue;
                result.push({
                  label: String(label).replace(/~/g, ''),
                  url,
                  children,
                });
              }
              // Remove empty, leading and duplicate separators after filtering.
              return result.filter(
                (item, index) =>
                  item.label ||
                  (index > 0 &&
                    result[index - 1].label &&
                    result.slice(index + 1).some((next) => next.label)),
              );
            }
            // Query command state after returning from the native menu callback;
            // status listeners can otherwise re-enter the locked UI event loop.
            setTimeout(() => {
              try {
                send({ cmd: 'context-menu', menus: items(event.ActionTriggerContainer) });
              } catch (error) {
                send({ cmd: 'menu-error', error: String(error) });
              }
            }, 0);
            return css.ui.ContextMenuInterceptorAction.CANCELLED;
          },
        });
        model.getCurrentController().registerContextMenuInterceptor(contextMenuInterceptor);
        let menuStep = 'module';
        try {
          const moduleId = css.frame.ModuleManager.create(context).identify(model);
          menuStep = 'config';
          const configuration = context
            .getServiceManager()
            .createInstanceWithContext(
              'com.sun.star.ui.ModuleUIConfigurationManagerSupplier',
              context,
            )
            .getUIConfigurationManager(moduleId);
          menuStep = 'descriptions';
          const descriptions = context
            .getServiceManager()
            .createInstanceWithContext('com.sun.star.frame.UICommandDescription', context)
            .getByName(moduleId);
          commandDescriptions = descriptions;
          const branches = new Map();
          function tree(items, parent = '') {
            const out = [];
            if (!items) return out;
            for (let i = 0; i < items.getCount(); i++) {
              const props = Object.fromEntries(items.getByIndex(i).map((p) => [p.Name, p.Value]));
              let label = props.Label || '';
              try {
                if (!label && props.CommandURL)
                  label =
                    Object.fromEntries(
                      descriptions.getByName(props.CommandURL).map((p) => [p.Name, p.Value]),
                    ).Label || '';
              } catch {}
              if (props.CommandURL && label) commandLabels.set(props.CommandURL, label);
              const path = parent + '/' + i;
              if (props.ItemDescriptorContainer) branches.set(path, props.ItemDescriptorContainer);
              out.push({
                label: String(label).replace(/~/g, ''),
                url: props.CommandURL || '',
                path,
                lazy: !!props.ItemDescriptorContainer,
                children: [],
              });
            }
            return out;
          }
          menuStep = 'tree';
          const menus = tree(configuration.getSettings('private:resource/menubar/menubar', false));
          menuBranch = (path) => tree(branches.get(path), path);
          menuStep = 'hide';
          if (menus.length) {
            frame.LayoutManager.hideElement('private:resource/menubar/menubar');
            send({ cmd: 'menus', menus });
          }
        } catch (error) {
          send({
            cmd: 'menu-error',
            error: menuStep + ': ' + String(error) + (error.Message || ''),
          });
        }
        frame.activate();
        frame.getComponentWindow().setFocus();
        try {
          const device = css.awt.Toolkit.create(context).createScreenCompatibleDevice(0, 0);
          send({ cmd: 'font-list', families: [...new Set(device.getFontDescriptors().map(f => f.Name))].sort() });
        } catch (error) { send({ cmd: 'menu-error', error: 'Font list: ' + String(error) }); }
        send({ cmd: 'ready' });
      } else if (d.cmd === 'set-font') {
        try {
          if (typeof d.family !== 'string' || !d.family || d.family.length > 120) throw Error('字体名称无效');
          const controller = model.getCurrentController();
          const selection = model.getText ? controller.getViewCursor() : model.getCurrentSelection();
          const targets = selection?.getPropertySetInfo ? [selection]
            : selection?.getCount ? Array.from({ length: selection.getCount() }, (_, i) => selection.getByIndex(i)) : [];
          const usable = targets.filter(t => t.getPropertySetInfo?.().hasPropertyByName('CharFontName'));
          if (!usable.length) throw Error('请先选中文字、文本框或单元格');
          const undo = model.getUndoManager();
          undo.enterUndoContext('设置字体');
          try {
            for (const target of usable) for (const name of ['CharFontName', 'CharFontNameAsian', 'CharFontNameComplex']) {
              if (target.getPropertySetInfo().hasPropertyByName(name)) target.setPropertyValue(name, d.family);
            }
          } finally { undo.leaveUndoContext(); }
          send({ cmd: 'font-result', fonts: usable.map(t => ({ western: t.getPropertyValue('CharFontName'), asian: t.getPropertyValue('CharFontNameAsian') })) });
        } catch (error) { send({ cmd: 'font-result', error: String(error) }); }
      } else if (d.cmd === 'menu-expand') {
        send({ cmd: 'menu-items', path: d.path, items: menuBranch(d.path) });
      } else if (d.cmd === 'export') {
        model.store();
        send({ cmd: 'exported' });
      } else if (d.cmd === 'save') {
        model.store();
        send({ cmd: 'saved', generation: d.generation, download: d.download });
      } else if (d.cmd === 'dispatch') {
        css.frame.DispatchHelper.create(context).executeDispatch(
          model.getCurrentController().getFrame(),
          commandTarget(d.url),
          '',
          0,
          d.image ? [property('FileName', 'file:///tmp/wing/' + d.image)] : [],
        );
      } else if (d.cmd === 'action') {
        let result = {};
        let changed = false;
        if (d.action === 'insert_text') {
          if (model.getText) {
            const cursor = model.getCurrentController().getViewCursor();
            model.getText().insertString(cursor, String(d.args.text || ''), false);
          } else if (model.getDrawPages) {
            const page = model.getCurrentController().getCurrentPage();
            const shape = model.createInstance('com.sun.star.drawing.TextShape');
            shape.setPosition(new css.awt.Point({ X: 2000, Y: 2000 }));
            shape.setSize(new css.awt.Size({ Width: 20000, Height: 4000 }));
            page.add(shape);
            shape.setString(String(d.args.text || ''));
          } else throw Error('请使用单元格操作修改表格');
          changed = true;
        } else if (d.action === 'insert_slide') {
          const pages = model.getDrawPages();
          const page = pages.insertNewByIndex(pages.getCount());
          model.getCurrentController().setCurrentPage(page);
          changed = true;
          result = { slides: pages.getCount() };
        } else if (d.action === 'set_cell') {
          const sheet = model.getSheets().getByIndex(d.args.sheet || 0),
            cell = sheet.getCellByPosition(d.args.column, d.args.row);
          cell.setFormula(String(d.args.value));
          changed = true;
        } else if (d.action === 'format') {
          const commands = {
            bold: '.uno:Bold',
            italic: '.uno:Italic',
            underline: '.uno:Underline',
            undo: '.uno:Undo',
            redo: '.uno:Redo',
            align_center: '.uno:CenterPara',
            align_left: '.uno:LeftPara',
          };
          const command = commands[d.args.command];
          if (!command) throw Error('不支持此格式操作');
          css.frame.DispatchHelper.create(context).executeDispatch(
            model.getCurrentController().getFrame(),
            command,
            '',
            0,
            [],
          );
          changed = true;
        } else if (d.action === 'read_selection') {
          const sel = model.getCurrentSelection();
          result = { text: sel?.getString?.() || '', type: filename.split('.').pop() };
        } else throw Error('不支持此操作');
        send({ cmd: 'result', id: d.id, result, changed });
      }
    } catch (error) {
      if (d.id) send({ cmd: 'result', id: d.id, error: String(error) });
      else send({ cmd: 'error', error: String(error) });
    }
  };
  send({ cmd: 'running' });
});
