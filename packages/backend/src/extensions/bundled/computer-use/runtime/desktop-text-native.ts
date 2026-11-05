/** Windows literal-text paste, owned by the desktop extension. Clipboard data never leaves the helper. */
export const DESKTOP_TEXT_SOURCE = String.raw`
  [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
  static IDataObject CopyClipboard(){
    var source=Clipboard.GetDataObject();if(source==null)return null;var copy=new DataObject();
    foreach(string format in source.GetFormats(false)){
      object value=source.GetData(format,false);if(value==null)continue;
      if(value is MemoryStream)value=new MemoryStream(((MemoryStream)value).ToArray());
      else if(value is byte[])value=((byte[])value).Clone();
      else if(value is string[])value=((string[])value).Clone();
      else if(value is Image)value=((Image)value).Clone();
      else if(!(value is string)&&!value.GetType().IsValueType)throw new Exception("Clipboard format cannot be safely preserved; no text was pasted.");
      copy.SetData(format,false,value);
    }return copy;
  }
  static void PasteLiteralText(Dictionary<string,object> req,IntPtr hwnd,uint pid,string text){
    IDataObject saved=null;uint owned=0;bool clipboardSet=false;
    try{
      OnUi(delegate{
        uint before=GetClipboardSequenceNumber();saved=CopyClipboard();
        if(before!=GetClipboardSequenceNumber())throw new Exception("Clipboard changed while preparing text; no paste was started.");
        var data=new DataObject();data.SetData(DataFormats.UnicodeText,false,text);
        data.SetData("CanIncludeInClipboardHistory",false,new MemoryStream(new byte[4]));
        data.SetData("CanUploadToCloudClipboard",false,new MemoryStream(new byte[4]));
        Clipboard.SetDataObject(data,true,3,20);owned=GetClipboardSequenceNumber();clipboardSet=true;
      });
      Root(req,true,true);CheckKeyboard(hwnd,pid);
      if(GetClipboardSequenceNumber()!=owned)throw new Exception("Clipboard changed before paste; no text was pasted.");
      var held=new List<ushort>();
      try{foreach(ushort key in new ushort[]{0x11,0x56}){CheckKeyboard(hwnd,pid);Send(Key(key,0,0));held.Add(key);}}
      finally{Exception releaseError=null;for(int i=held.Count-1;i>=0;i--){try{Send(Key(held[i],KEYUP,0));}catch(Exception e){releaseError=e;}}if(releaseError!=null)throw releaseError;}
      // Let the destination process consume the paste before restoring clipboard ownership.
      for(int i=0;i<22;i++){if(Stopped)break;Thread.Sleep(10);}
    }finally{
      if(clipboardSet)OnUi(delegate{
        // Never overwrite a copy made by the user or another application during input.
        if(GetClipboardSequenceNumber()==owned){if(saved==null)Clipboard.Clear();else Clipboard.SetDataObject(saved,true,3,20);}
      });
    }
  }
`;
