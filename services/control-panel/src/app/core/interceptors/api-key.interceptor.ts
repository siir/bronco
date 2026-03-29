import { HttpInterceptorFn } from '@angular/common/http';

export const apiKeyInterceptor: HttpInterceptorFn = (req, next) => {
  const apiKey = sessionStorage.getItem('rc_api_key') ?? '';
  if (apiKey && req.url.startsWith('/api')) {
    const cloned = req.clone({
      setHeaders: { 'X-Api-Key': apiKey },
    });
    return next(cloned);
  }
  return next(req);
};
