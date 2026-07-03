import { Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { IonContent, ToastController } from '@ionic/angular';
import { MecanicoService } from '../../services/mecanico.service';
import { AuthService } from '../../services/auth.service';
import { abrirWhatsApp } from '../../shared/whatsapp.util';
import { Subject, interval } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

@Component({
  standalone: false,
  selector: 'app-mecanico-contacto',
  templateUrl: './mecanico-contacto.page.html',
  styleUrls: ['./mecanico-contacto.page.scss'],
})
export class MecanicoContactoPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  @ViewChild(IonContent) content?: IonContent;

  contacto: { nombre: string; telefono: string } | null = null;
  equipo: { id: number; nombre: string; telefono: string; foto: string | null }[] = [];
  mensajes: any[] = [];
  cargando = true;
  texto = '';
  enviando = false;
  destino: 'recepcion' | 'admin' = 'recepcion';   // a quién le escribo
  miId = this.auth.getUsuario()?.id;
  fotoPreview: string | null = null;
  mostrarRapidas = false;

  readonly respuestasRapidas = [
    'Listo para entregar',
    'Necesito repuesto',
    'Esperando aprobación del cliente',
    'Moto lista para prueba',
    'Necesito ayuda con esta moto',
  ];

  constructor(private mecanico: MecanicoService, private auth: AuthService, private toast: ToastController) {}

  ngOnInit() {
    this.cargar();
    interval(15000).pipe(takeUntil(this.destroy$)).subscribe(() => this.refrescar());
  }

  ionViewWillEnter() { this.cargar(); }
  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  cargar(ev?: any) {
    this.cargando = true;
    this.mecanico.getRecepcionContacto().pipe(takeUntil(this.destroy$)).subscribe({ next: (r: any) => { this.contacto = r.data; this.equipo = r.equipo || []; } });
    this.mecanico.getMensajes().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => {
        this.mensajes = r.data;
        this.cargando = false;
        if (ev) ev.target.complete();
        this.scrollAbajo();
      },
      error: () => { this.cargando = false; if (ev) ev.target.complete(); },
    });
  }

  private refrescar() {
    this.mecanico.getMensajes().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => {
        const tenia = this.mensajes.length;
        this.mensajes = r.data;
        if (r.data.length > tenia) this.scrollAbajo();
      },
    });
  }

  esMio(m: any): boolean { return m.remitente_id === this.miId; }

  enviar(textoOverride?: string) {
    const txt = (textoOverride || this.texto).trim();
    const foto = this.fotoPreview;
    if (!txt && !foto) return;
    this.enviando = true;
    this.mostrarRapidas = false;
    this.mecanico.enviarMensaje(txt, foto, null, this.destino).pipe(takeUntil(this.destroy$)).subscribe({
      next: r => {
        this.mensajes.push(r.data);
        this.texto = '';
        this.fotoPreview = null;
        this.enviando = false;
        this.scrollAbajo();
      },
      error: async () => {
        this.enviando = false;
        const t = await this.toast.create({ message: 'No se pudo enviar', duration: 1800, color: 'danger' });
        await t.present();
      },
    });
  }

  enviarRapida(msg: string) {
    this.enviar(msg);
  }

  adjuntarFoto() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) {
        this.toast.create({ message: 'La imagen es muy grande (máx 4 MB)', duration: 2000, color: 'warning' }).then(t => t.present());
        return;
      }
      const reader = new FileReader();
      reader.onload = () => { this.fotoPreview = reader.result as string; };
      reader.readAsDataURL(file);
    };
    input.click();
  }

  quitarFoto() { this.fotoPreview = null; }

  llamar() { if (this.contacto?.telefono) window.open(`tel:${this.contacto.telefono}`, '_self'); }
  whatsapp() { if (this.contacto?.telefono) abrirWhatsApp(this.contacto.telefono, ''); }
  llamarA(tel: string) { window.open(`tel:${tel}`, '_self'); }
  whatsappA(tel: string) { abrirWhatsApp(tel, ''); }

  private scrollAbajo() { setTimeout(() => this.content?.scrollToBottom(150), 80); }

  // Separadores por día
  mostrarSeparador(i: number): boolean {
    if (i === 0) return true;
    return this.diaDe(this.mensajes[i].created_at) !== this.diaDe(this.mensajes[i - 1].created_at);
  }

  private diaDe(fecha: string): string { return fecha ? fecha.slice(0, 10) : ''; }

  etiquetaDia(fecha: string): string {
    if (!fecha) return '';
    const hoy = new Date().toISOString().slice(0, 10);
    const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const d = fecha.slice(0, 10);
    if (d === hoy) return 'Hoy';
    if (d === ayer) return 'Ayer';
    const f = new Date(fecha);
    return f.toLocaleDateString('es-CR', { day: 'numeric', month: 'short' });
  }

  horaExacta(fecha: string): string {
    if (!fecha) return '';
    const f = new Date(fecha);
    return f.toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit', hour12: true });
  }
}
