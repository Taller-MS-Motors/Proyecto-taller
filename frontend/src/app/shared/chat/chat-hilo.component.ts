import { Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Optional, Output } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, ToastController } from '@ionic/angular';
import { Subject, interval } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { MensajeriaService, ChatContacto } from '../../services/mensajeria.service';
import { AuthService } from '../../services/auth.service';
import { abrirWhatsApp } from '../whatsapp.util';

// Hilo de conversación 1:1 (o feed de Avisos del taller con modo="avisos").
// Burbujas, separadores por día, acuse ✓/✓✓, foto y chip de orden. Lo usan los 3 roles.
@Component({
  standalone: false,
  selector: 'app-chat-hilo',
  templateUrl: './chat-hilo.component.html',
  styleUrls: ['./chat-hilo.component.scss'],
})
export class ChatHiloComponent implements OnInit, OnChanges, OnDestroy {
  private destroy$ = new Subject<void>();
  @Input() contacto: ChatContacto | null = null;
  @Input() modo: 'dm' | 'avisos' = 'dm';
  @Output() volver = new EventEmitter<void>();

  mensajes: any[] = [];
  cargando = true;
  texto = '';
  enviando = false;
  fotoPreview: string | null = null;
  mostrarRapidas = false;
  miId = this.auth.getUsuario()?.id;
  miRol = this.auth.getUsuario()?.rol;

  readonly rolLabel: Record<string, string> = {
    tecnico: 'Mecánico', recepcion: 'Recepción', admin: 'Dueño / Admin',
  };
  readonly respuestasRapidas = [
    'Listo para entregar',
    'Necesito repuesto',
    'Esperando aprobación del cliente',
    'Moto lista para prueba',
    'Necesito ayuda con esta moto',
  ];

  constructor(
    private msj: MensajeriaService,
    private auth: AuthService,
    private router: Router,
    private toast: ToastController,
    @Optional() private content: IonContent,
  ) {}

  ngOnInit() {
    this.cargar();
    interval(12000).pipe(takeUntil(this.destroy$)).subscribe(() => this.refrescar());
  }
  ngOnChanges() { if (this.mensajes.length) this.cargar(); }
  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  get esAvisos(): boolean { return this.modo === 'avisos'; }
  // En Avisos solo escribe la oficina; el mecánico lo lee.
  get puedeEscribir(): boolean { return !this.esAvisos || this.miRol === 'admin' || this.miRol === 'recepcion'; }
  get esTecnico(): boolean { return this.miRol === 'tecnico'; }

  cargar() {
    this.cargando = true;
    const src$ = this.esAvisos ? this.msj.getAvisos() : this.msj.getConversacion(this.contacto!.id);
    src$.pipe(takeUntil(this.destroy$)).subscribe({
      next: (r: any) => { this.mensajes = r.data || []; this.cargando = false; this.scrollAbajo(); },
      error: () => { this.cargando = false; },
    });
  }

  private refrescar() {
    const src$ = this.esAvisos ? this.msj.getAvisos() : this.msj.getConversacion(this.contacto!.id);
    src$.pipe(takeUntil(this.destroy$)).subscribe({
      next: (r: any) => {
        const tenia = this.mensajes.length;
        this.mensajes = r.data || [];
        if (this.mensajes.length > tenia) this.scrollAbajo();
      },
    });
  }

  enviar(textoOverride?: string) {
    const txt = (textoOverride || this.texto).trim();
    const foto = this.fotoPreview;
    if ((!txt && !foto) || this.enviando) return;
    this.enviando = true;
    this.mostrarRapidas = false;
    const req$ = this.esAvisos ? this.msj.enviarAviso(txt, foto) : this.msj.enviar(this.contacto!.id, txt, foto);
    req$.pipe(takeUntil(this.destroy$)).subscribe({
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

  esMio(m: any): boolean { return m.remitente_id === this.miId; }
  abrirOrden(id: number) { if (id) this.router.navigate(['/detalle-orden', id]); }
  llamar() { if (this.contacto?.telefono) window.open(`tel:${this.contacto.telefono}`, '_self'); }
  whatsapp() { if (this.contacto?.telefono) abrirWhatsApp(this.contacto.telefono, ''); }

  iniciales(nombre?: string): string {
    const p = (nombre || '?').trim().split(/\s+/);
    return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase();
  }

  private scrollAbajo() { setTimeout(() => this.content?.scrollToBottom(150), 80); }

  mostrarSeparador(i: number): boolean {
    if (i === 0) return true;
    return (this.mensajes[i].created_at || '').slice(0, 10) !== (this.mensajes[i - 1].created_at || '').slice(0, 10);
  }

  etiquetaDia(fecha: string): string {
    if (!fecha) return '';
    const hoy = new Date().toISOString().slice(0, 10);
    const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const d = fecha.slice(0, 10);
    if (d === hoy) return 'Hoy';
    if (d === ayer) return 'Ayer';
    return new Date(fecha).toLocaleDateString('es-CR', { day: 'numeric', month: 'short' });
  }

  horaExacta(fecha: string): string {
    if (!fecha) return '';
    return new Date(fecha).toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit', hour12: true });
  }
}
