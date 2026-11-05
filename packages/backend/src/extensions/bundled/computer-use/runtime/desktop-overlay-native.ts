/** Desktop-only decoration. The accent follows GetCursorPos; it never injects input. */
export const DESKTOP_OVERLAY_SOURCE = String.raw`
  static readonly List<Form> Edges = new List<Form>();
  static PointerAccent Accent;
  static System.Windows.Forms.Timer AccentTimer;
  static string DisplayLayout="";
  static void ShowControl(){
    if(Bar==null||Bar.IsDisposed)Bar=new StopBar();Bar.SetTitle(OverlayTitle);Bar.Show();ShowWindow(Bar.Handle,4);
    string layout=String.Join(";",Screen.AllScreens.Select(s=>s.Bounds.ToString()));
    if(DisplayLayout!=layout){foreach(var edge in Edges)edge.Dispose();Edges.Clear();DisplayLayout=layout;
      foreach(var screen in Screen.AllScreens){var b=screen.Bounds;int size=Math.Max(6,(int)(10*screen.Bounds.Width/1920.0));
        Edges.Add(new EdgeGlow(new Rectangle(b.Left,b.Top,b.Width,size),90));
        Edges.Add(new EdgeGlow(new Rectangle(b.Left,b.Bottom-size,b.Width,size),270));
        Edges.Add(new EdgeGlow(new Rectangle(b.Left,b.Top,size,b.Height),0));
        Edges.Add(new EdgeGlow(new Rectangle(b.Right-size,b.Top,size,b.Height),180));
      }
    }
    foreach(var edge in Edges){edge.Show();ShowWindow(edge.Handle,4);}
    if(Accent==null||Accent.IsDisposed)Accent=new PointerAccent();
    if(AccentTimer==null){AccentTimer=new System.Windows.Forms.Timer{Interval=16};AccentTimer.Tick+=delegate{if(OverlayWanted&&!Stopped)Accent.Follow();};}
    Accent.Follow();AccentTimer.Start();
  }
  static IntPtr InputHit(POINT point){
    IntPtr hit=WindowFromPoint(point);
    bool passive=(Accent!=null&&Accent.IsHandleCreated&&hit==Accent.Handle)||Edges.Any(e=>e.IsHandleCreated&&hit==e.Handle);
    if(!passive)return hit;
    // WindowFromPoint may report a click-through decoration. Inspect beneath our
    // passive surfaces, but never hide/bypass the user's stop or approval controls.
    OnUi(delegate{var visible=Edges.Where(e=>e.Visible).ToArray();bool pointer=Accent!=null&&Accent.Visible;
      foreach(var edge in visible)edge.Hide();if(pointer)Accent.Hide();
      try{hit=WindowFromPoint(point);}finally{foreach(var edge in visible)edge.Show();if(pointer)Accent.Show();}
    });return hit;
  }
  static void HideControl(){if(Bar!=null)Bar.Hide();foreach(var edge in Edges)edge.Hide();if(AccentTimer!=null)AccentTimer.Stop();if(Accent!=null)Accent.Hide();}
  class PassiveSurface:Form {
    public PassiveSurface(){FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;TopMost=true;Text="Wing · 桌面提示";StartPosition=FormStartPosition.Manual;DoubleBuffered=true;BackColor=Color.Fuchsia;TransparencyKey=Color.Fuchsia;}
    protected override bool ShowWithoutActivation{get{return true;}}
    protected override CreateParams CreateParams{get{var p=base.CreateParams;p.ExStyle|=0x08000000|0x00000080|0x20;return p;}}
    protected override void WndProc(ref Message m){if(m.Msg==0x84){m.Result=new IntPtr(-1);return;}base.WndProc(ref m);}
    protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);SetWindowDisplayAffinity(Handle,0x11);}
  }
  class EdgeGlow:PassiveSurface {
    readonly float Angle;
    public EdgeGlow(Rectangle bounds,float angle){Bounds=bounds;Angle=angle;Opacity=.55;}
    protected override void OnPaint(PaintEventArgs e){using(var brush=new LinearGradientBrush(ClientRectangle,Color.FromArgb(40,192,230),Color.FromArgb(10,45,74),Angle))e.Graphics.FillRectangle(brush,ClientRectangle);}
  }
  class PointerAccent:PassiveSurface {
    public PointerAccent(){Size=new Size(36,42);}
    public void Follow(){POINT point;if(!GetCursorPos(out point)){Hide();return;}
      // Keep the accent visible while typing, even when the app hides its I-beam.
      Location=new Point(point.X,point.Y);Invalidate();if(!Visible){Show();ShowWindow(Handle,4);}}
    protected override void OnPaint(PaintEventArgs e){e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;
      using(var fill=new SolidBrush(Color.FromArgb(30,182,216)))using(var outline=new Pen(Color.White,1.7f)){
        var path=new Point[]{new Point(1,1),new Point(1,24),new Point(7,18),new Point(12,29),new Point(17,27),new Point(12,16),new Point(22,16)};e.Graphics.FillPolygon(fill,path);e.Graphics.DrawPolygon(outline,path);
      }
    }
  }
  class StopBar:Form {
    readonly Label Caption;
    public StopBar(){FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;TopMost=true;StartPosition=FormStartPosition.Manual;BackColor=Color.FromArgb(19,43,60);Size=new Size(402,48);Text="Wing · 桌面控制";
      var screen=Screen.FromPoint(Cursor.Position).WorkingArea;Location=new Point(screen.Left+(screen.Width-Width)/2,screen.Top+12);
      Caption=new Label{Text="Wing 正在操作电脑",ForeColor=Color.White,Location=new Point(14,15),Size=new Size(154,22),AutoEllipsis=true,Font=new Font("Microsoft YaHei",9)};Controls.Add(Caption);
      Controls.Add(new Label{Text="Ctrl+Alt+Esc",ForeColor=Color.FromArgb(143,213,226),Location=new Point(175,16),Size=new Size(100,21),Font=new Font("Segoe UI",9)});
      var stop=new Button{Text="停止",Location=new Point(320,8),Size=new Size(70,32),BackColor=Color.FromArgb(35,76,94),ForeColor=Color.White,FlatStyle=FlatStyle.Flat};stop.FlatAppearance.BorderSize=0;stop.Click+=delegate{Stop();};Controls.Add(stop);
      FormClosing+=delegate(object s,FormClosingEventArgs e){e.Cancel=true;Stop();};
    }
    public void SetTitle(string text){Caption.Text="Wing 正在操作电脑";Caption.AccessibleDescription=text;}
    protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);using(var pen=new Pen(Color.FromArgb(45,183,205),2))e.Graphics.DrawLine(pen,12,1,Width-12,1);}
    protected override bool ShowWithoutActivation{get{return true;}}
    protected override CreateParams CreateParams{get{var p=base.CreateParams;p.ExStyle|=0x08000000|0x00000080;return p;}}
    protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);using(var path=new GraphicsPath()){int d=18;path.AddArc(0,0,d,d,180,90);path.AddArc(Width-d,0,d,d,270,90);path.AddArc(Width-d,Height-d,d,d,0,90);path.AddArc(0,Height-d,d,d,90,90);path.CloseFigure();Region=new Region(path);}SetWindowDisplayAffinity(Handle,0x11);}
  }
`;
