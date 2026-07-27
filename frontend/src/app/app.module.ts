import { APP_INITIALIZER, NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { RouteReuseStrategy } from '@angular/router';
import { HTTP_INTERCEPTORS, provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';

import { IonicModule, IonicRouteStrategy } from '@ionic/angular';

import { AppComponent } from './app.component';
import { AppRoutingModule } from './app-routing.module';
import { AuthInterceptor } from './interceptors/auth.interceptor';
import { ApiUrlInterceptor } from './interceptors/api-url.interceptor';
import { ErrorInterceptor } from './interceptors/error.interceptor';
import { AuthService } from './services/auth.service';
import { PortalService } from './services/portal.service';

// En nativo, hidrata las sesiones (staff + cliente) desde el Keychain/Keystore ANTES
// de que Angular termine de arrancar — así los guards de ruta ya ven el token real
// en su primera evaluación. En web resuelve al instante (ya se hidrató en el
// constructor de cada servicio, ver auth.service.ts / portal.service.ts).
function initSesiones(auth: AuthService, portal: PortalService) {
  return () => Promise.all([auth.init(), portal.init()]);
}

@NgModule({
  declarations: [AppComponent],
  imports: [BrowserModule, IonicModule.forRoot(), AppRoutingModule],
  providers: [
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    { provide: APP_INITIALIZER, useFactory: initSesiones, deps: [AuthService, PortalService], multi: true },
    // El de URL primero (reescribe a absoluta en nativo) y luego el de auth (token).
    { provide: HTTP_INTERCEPTORS, useClass: ApiUrlInterceptor, multi: true },
    { provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true },
    { provide: HTTP_INTERCEPTORS, useClass: ErrorInterceptor, multi: true },
    provideHttpClient(withInterceptorsFromDi()),
  ],
  bootstrap: [AppComponent],
})
export class AppModule {}
