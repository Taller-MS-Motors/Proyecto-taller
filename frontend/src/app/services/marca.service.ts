import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map, shareReplay } from 'rxjs/operators';
import { environment } from '../../environments/environment';

export interface Marca {
  nombre_taller: string;
  telefono: string | null;
  email: string | null;
  direccion: string | null;
  logo: string | null;            // data URL, o null si no cargaron ninguno
  garantia_dias: number;
  metodos_pago: { valor: string; etiqueta: string }[];
}

// Identidad y valores por defecto del taller, para documentos y formularios.
// Se cachea: los usa la factura, el PDF y el cierre de orden, y cambia muy de vez en
// cuando. Si la petición falla, se responde con los valores de fábrica en vez de
// romper la pantalla — una factura sin logo se imprime igual.
const RESPALDO: Marca = {
  nombre_taller: 'MS Motos',
  telefono: null, email: null, direccion: null, logo: null,
  garantia_dias: 30,
  metodos_pago: [
    { valor: 'efectivo', etiqueta: 'Efectivo' },
    { valor: 'sinpe', etiqueta: 'SINPE Móvil' },
    { valor: 'tarjeta', etiqueta: 'Tarjeta' },
    { valor: 'transferencia', etiqueta: 'Transferencia' },
  ],
};

@Injectable({ providedIn: 'root' })
export class MarcaService {
  private url = `${environment.apiUrl}/marca`;
  private cache$: Observable<Marca> | null = null;

  constructor(private http: HttpClient) {}

  get(): Observable<Marca> {
    if (!this.cache$) {
      this.cache$ = this.http.get<{ data: Marca }>(this.url).pipe(
        map(r => ({ ...RESPALDO, ...r.data })),
        catchError(() => of(RESPALDO)),
        shareReplay(1),
      );
    }
    return this.cache$;
  }

  // Tras guardar la configuración, para que la próxima lectura traiga lo nuevo.
  invalidar() { this.cache$ = null; }

  // Logo para documentos: el configurado, o el que viene con la app.
  logoParaDocumento(m: Marca | null): string {
    return m?.logo || 'assets/logo/ms-logo.png';
  }
}
