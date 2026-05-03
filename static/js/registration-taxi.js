const clientChoiceTaxi = document.querySelector('.register-choice-client');
const taxiChoiceTaxi = document.querySelector('.register-choice-taxi');
const registerRulesCheckTaxi = document.getElementById('registerRulesCheckTaxi');
const registerChoiceButtonTaxi = document.getElementById('register-choice-btn');

const registerChoiceContainerTaxi = document.querySelector('.register-choice-container'); 
const registerClientContainerTaxi = document.querySelector('.register-client-container');
const registerTaxiContainerTaxi = document.querySelector('.register-taxi-container');

const registerClientPhoneTaxi = document.getElementById('registerPhoneTaxi');
const registerClientNameTaxi = document.getElementById('registerNameTaxi');
const registerClientSurnameTaxi = document.getElementById('registerSurnameTaxi');
const registerClientPasswordTaxi = document.getElementById('registerPasswordTaxi');
const carYearTaxi = document.getElementById('carYearTaxi');
const carNumberTaxi = document.getElementById('carNumberTaxi');
const carNameTaxi = document.getElementById('carNameTaxi');
const techPassportTaxi = document.getElementById('techPassportTaxi');
const driverLicenseTaxi = document.getElementById('driverLicenseTaxi');
const carPhotoTaxi = document.getElementById('carPhotoTaxi');
const driverLicensePhotoTaxi = document.getElementById('driverLicensePhotoTaxi');
const techPassportPhotoTaxi = document.getElementById('techPassportPhotoTaxi');
const facePhotoTaxi = document.getElementById('facePhotoTaxi');

const registerButtonTaxi = document.getElementById('register-btn-taxi');
const registerPasswordToggleTaxi = document.querySelector('.password-toggle-taxi');
const registrationMessageTaxi = document.getElementById('registrationMessageTaxi');
const registerInputsTaxi = document.querySelector('.register-inputs-taxi');

function clearRegisterTaxiPhotoErrors() {
    document.querySelectorAll('.register-taxi-container .profile-edit-upload.is-error').forEach((el) => {
        el.classList.remove('is-error');
    });
}

function bindRegisterTaxiPhotoUploads() {
    const root = document.querySelector('.register-taxi-container');
    if (!root) return;
    root.querySelectorAll('.profile-edit-file-input').forEach((inp) => {
        if (inp.dataset.boundRegTaxiPhoto) return;
        inp.dataset.boundRegTaxiPhoto = '1';
        inp.addEventListener('change', () => {
            const wrap = inp.closest('.profile-edit-upload');
            const nameEl = wrap?.querySelector('.profile-edit-upload-name');
            const f = inp.files && inp.files[0];
            if (nameEl) nameEl.textContent = f ? f.name : '';
            if (wrap) {
                wrap.classList.toggle('has-file', !!f);
                wrap.classList.remove('is-error');
            }
        });
    });
}

// Проверка перед отправкой формы (eyni məntiqi ilə ki, profil redaktəsi)
function validatePhotos() {
    let valid = true;
    const root = document.querySelector('.register-taxi-container');
    if (!root) return false;

    root.querySelectorAll('.register-taxi-photo-uploads .profile-edit-file-input').forEach((input) => {
        const wrap = input.closest('.profile-edit-upload');
        if (!wrap) return;
        wrap.classList.remove('is-error');
        if (!input.files || input.files.length === 0) {
            wrap.classList.add('is-error');
            valid = false;
        }
    });

    if (!valid) {
        showErrorTaxi('Bütün şəkilləri əlavə edin!');
    }
    return valid;
}



// Добавляем сообщение для отображения статуса
if (!registrationMessageTaxi) {
    const messageDiv = document.createElement('div');
    messageDiv.id = 'registrationMessageTaxi';
    messageDiv.className = 'registration-message';
    registerClientContainerTaxi.insertBefore(messageDiv, registerButtonTaxi);
}

clientChoiceTaxi.addEventListener("click", () => {
  clientChoiceTaxi.classList.add("active");
  clientChoiceTaxi.classList.remove("error");
  taxiChoiceTaxi.classList.remove("error");
  taxiChoiceTaxi.classList.remove("active");
  registartionType = "client";
  console.log("TAXI:", registartionType)
  registerChoiceButtonTaxi.disabled = false;
  
});

taxiChoiceTaxi.addEventListener("click", () => {
  taxiChoiceTaxi.classList.add("active");
  taxiChoiceTaxi.classList.remove("error");
  clientChoiceTaxi.classList.remove("active");
  clientChoiceTaxi.classList.remove("error");
  registartionType = "taxi";
  registerChoiceButtonTaxi.disabled = false;
});

registerChoiceButtonTaxi.addEventListener("click", () => {
  if (!registartionType) {
    taxiChoiceTaxi.classList.add("error");
    clientChoiceTaxi.classList.add("error");
    return;
  }
 
  if (registartionType === "client") {
    registerChoiceContainerTaxi.style.display = "none";
    registerClientContainerTaxi.style.display = "block";
    registerTaxiContainerTaxi.style.display = "none";
  } else if (registartionType === "taxi") {
    registerChoiceContainer.style.display = "none";
    registerClientContainer.style.display = "none";
    registerTaxiContainer.style.display = "block";
  }
});




const registerContainer = document.querySelector('.register-taxi-container');
if (registerContainer) {
  registerContainer.addEventListener('click', (e) => {
    if (e.target.closest('.register-taxi-photo-uploads .profile-edit-upload')) {
      return;
    }

    if (e.target.matches('input[type="text"], input[type="password"], input[type="number"]')) {
      registerClientPhoneTaxi.classList.remove('error');
      registerClientNameTaxi.classList.remove('error');
      registerClientSurnameTaxi.classList.remove('error');
      registerClientPasswordTaxi.classList.remove('error');
      registerRulesCheckTaxi.classList.remove('error');

      clearRegisterTaxiPhotoErrors();
      driverLicenseTaxi.classList.remove('error');
      techPassportTaxi.classList.remove('error');
      carNumberTaxi.classList.remove('error');
      carNameTaxi.classList.remove('error');
      carYearTaxi.classList.remove('error');

      registerClientPhoneTaxi.style.borderColor = '';
      registerClientNameTaxi.style.borderColor = '';
      registerClientSurnameTaxi.style.borderColor = '';
      registerClientPasswordTaxi.style.borderColor = '';
      registerRulesCheckTaxi.style.borderColor = '';

      driverLicenseTaxi.style.borderColor = '';
      techPassportTaxi.style.borderColor = '';
      carNumberTaxi.style.borderColor = '';
      carYearTaxi.style.borderColor = '';
      carNameTaxi.style.borderColor = '';
      hideMessageTaxi();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindRegisterTaxiPhotoUploads();
});

registerClientPhoneTaxi.addEventListener("input", () => {
  let value = registerClientPhoneTaxi.value.replace(/\D/g, '').slice(0, 9);
  let formatted = '';

  if (value.length > 0) formatted += value.slice(0, 2);
  if (value.length > 2) formatted += ' ' + value.slice(2, 5);
  if (value.length > 5) formatted += ' ' + value.slice(5, 7);
  if (value.length > 7) formatted += '-' + value.slice(7, 9);

  registerClientPhoneTaxi.value = formatted.trim();
});

registerPasswordToggleTaxi.addEventListener("click", () => {
  if (registerClientPasswordTaxi.type === "password") {
    registerClientPasswordTaxi.type = "text";
    registerPasswordToggleTaxi.innerHTML = '<i class="fas fa-eye-slash"></i>';
  } else {
    registerClientPasswordTaxi.type = "password";
    registerPasswordToggleTaxi.innerHTML = '<i class="fas fa-eye"></i>';
  }
});


registerButtonTaxi.addEventListener("click", async () => {
  // Сброс предыдущих ошибок
  resetErrorsTaxi();
  hideMessageTaxi();

  let valid = true;

  // Валидация данных
  if (registerClientNameTaxi.value.trim() === '') {
    registerClientNameTaxi.classList.add("error");
    showErrorTaxi("Имя обязательно для заполнения!");
    valid = false;
    return;
  }
  
  if (registerClientSurnameTaxi.value.trim() === '') {
    registerClientSurnameTaxi.classList.add("error");
    showErrorTaxi("Фамилия обязательна для заполнения!");
    valid = false;
    return;
  }

  if (carNameTaxi.value.trim() === '' || carNameTaxi.value.length < 6) {
    carNameTaxi.classList.add("error");
    showErrorTaxi("Название автомобиля обязательна для заполнения!");
    valid = false;
    return;
  }
  
  if (!registerClientPhoneTaxi.value.match(/^\d{2} \d{3} \d{2}-\d{2}$/)) {
    registerClientPhoneTaxi.classList.add("error");
    showErrorTaxi("Неверный формат телефона!");
    valid = false;
    return;
  }
  
  if (registerClientPasswordTaxi.value.length < 6) {
    registerClientPasswordTaxi.classList.add("error");
    showErrorTaxi("Пароль должен содержать минимум 6 символов!");
    valid = false;
    return;
  }

  // Валидные коды номеров Азербайджана
  const validAzerbaijanCodes = [
    "77", "70", "50", "51", 
    "55", "40", "60", "12", 
    "20", "88", "99"];

  // Проверка кода телефона
  if (!validAzerbaijanCodes.includes(registerClientPhoneTaxi.value.replace(/\D/g, "").substring(0, 2))) {
    registerClientPhoneTaxi.classList.add("error");
    showErrorTaxi("Недопустимый код телефона!");
    valid = false;
    return;
  }

  if (!carYearTaxi.value.match(/^(19|20)\d{2}$/)) {
    carYearTaxi.classList.add("error");
    showErrorTaxi("Неверный формат года выпуска авто!");
    valid = false;
    return;
  }

  if (!carNumberTaxi.value.match(/^[0-9]{2} [A-Z]{2} [0-9]{3}$/i)) {
    carNumberTaxi.classList.add("error");
    showErrorTaxi("Неверный формат гос номера авто!");
    valid = false;
    return;
  }

  // Обрезаем пробелы
  const techValue = techPassportTaxi.value.trim();
  const licenseValue = driverLicenseTaxi.value.trim();

  // Для техпаспорта
  if (!techValue.match(/^[A-Z]{2}\s*№?\s*\d{6}$/i)) {
      techPassportTaxi.classList.add("error");
      showErrorTaxi("Неверный формат тех. паспорта! Пример: AB № 123456");
      valid = false;
      return;
  }

  // Для водительского удостоверения
  if (!licenseValue.match(/^[A-Z]{2}\s*№?\s*\d{6}$/i)) {
      driverLicenseTaxi.classList.add("error");
      showErrorTaxi("Неверный формат водительских прав! Пример: AB № 123456");
      valid = false;
      return;
  }

  // Валидация фотографий
  if (!validatePhotos()) {
    valid = false;
    return;
  }

  if (!registerRulesCheckTaxi.checked) {
    registerRulesCheckTaxi.classList.add("error");
    showErrorTaxi("Необходимо согласие с правилами!");
    valid = false;
    return;
  }
  
  if (!valid) return;

  // Показываем загрузку
  setLoadingTaxi(true);

  try {
    // Функция для конвертации файла в base64
    const fileToBase64 = (file) => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => {
          const r = String(reader.result || "");
          const i = r.toLowerCase().lastIndexOf(";base64,");
          if (i >= 0) resolve(r.slice(i + 8));
          else {
            const j = r.indexOf(",");
            resolve(j >= 0 ? r.slice(j + 1) : r);
          }
        };
        reader.onerror = (error) => reject(error);
      });
    };

    // Получаем файлы и конвертируем в base64
    const carPhotoFile = carPhotoTaxi.files[0];
    const driverLicensePhotoFile = driverLicensePhotoTaxi.files[0];
    const techPassportPhotoFile = techPassportPhotoTaxi.files[0];
    const facePhotoFile = facePhotoTaxi.files[0];

    const [
      carPhotoBase64,
      driverLicensePhotoBase64,
      techPassportPhotoBase64,
      facePhotoBase64
    ] = await Promise.all([
      fileToBase64(carPhotoFile),
      fileToBase64(driverLicensePhotoFile),
      fileToBase64(techPassportPhotoFile),
      fileToBase64(facePhotoFile)
    ]);

    // Отправляем данные на сервер для таксиста
    const response = await fetch('/api/registration-taxi', {
      method: 'POST',
      credentials: 'include', 
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: registerClientNameTaxi.value.trim(),
        surname: registerClientSurnameTaxi.value.trim(),
        phone: registerClientPhoneTaxi.value,
        password: registerClientPasswordTaxi.value,
        car_name: carNameTaxi.value.trim(),
        car_year: parseInt(carYearTaxi.value),
        car_number: carNumberTaxi.value.trim(),
        tech_passport: techPassportTaxi.value.trim(),
        driver_license: driverLicenseTaxi.value.trim(),
        car_photo: carPhotoBase64,
        driver_license_photo: driverLicensePhotoBase64,
        tech_passport_photo: techPassportPhotoBase64,
        face_photo: facePhotoBase64,
        last_lat: window.taxiApp?.userLatLng?.lat || null,
        last_lng: window.taxiApp?.userLatLng?.lng || null,
        agree_to_terms: registerRulesCheckTaxi.checked
      })
    });

    const result = await response.json();

    if (result.success) {
      // Успешная регистрация
      showSuccessTaxi(result.message);
      
      // Перенаправляем на главную страницу через 2 секунды
      setTimeout(() => {
        resetForm();
        window.profileManager.loadProfileData();
        window.taxiApp.updateTaxiStatusUI('offline');
        window.location.reload();
        // window.taxiApp.showScreen('profile-screen');
        // window.profileManager.loadProfileData();
        // hideMessageTaxi();
        // setLoadingTaxi(false);
      }, 1000);
      
    } else {
      // Обработка ошибок сервера
      handleServerError_registartionTaxi(result);
    }

  } catch (error) {
    console.error('Ошибка при регистрации:', error);
    showErrorTaxi('Ошибка соединения с сервером. Попробуйте позже.');
  } finally {
    setLoadingTaxi(false);
  }
});

// Функция для сброса формы
function resetForm() {
  registerClientNameTaxi.value = '';
  registerClientSurnameTaxi.value = '';
  registerClientPhoneTaxi.value = '';
  registerClientPasswordTaxi.value = '';
  carYearTaxi.value = '';
  carNumberTaxi.value = '';
  techPassportTaxi.value = '';
  driverLicenseTaxi.value = '';
  registerRulesCheckTaxi.checked = false;

  const taxiRoot = document.querySelector('.register-taxi-container');
  if (taxiRoot) {
    taxiRoot.querySelectorAll('.profile-edit-file-input').forEach((inp) => {
      inp.value = '';
      const wrap = inp.closest('.profile-edit-upload');
      const nameEl = wrap?.querySelector('.profile-edit-upload-name');
      if (nameEl) nameEl.textContent = '';
      if (wrap) wrap.classList.remove('has-file', 'is-error');
    });
  }
}


// Функции для работы с сообщениями и состоянием
function showErrorTaxi(message) {
  const messageElement = document.getElementById('registrationMessageTaxi');
  if (messageElement) {
    messageElement.textContent = message;
    messageElement.classList.add('error');
    messageElement.classList.remove('success');
    messageElement.style.display = 'block';
  }
}

function showSuccessTaxi(message) {
  const messageElement = document.getElementById('registrationMessageTaxi');
  if (messageElement) {
    messageElement.textContent = message;
    messageElement.classList.add('success');
    messageElement.classList.remove('error');
    messageElement.style.display = 'block';
  }
}

function hideMessageTaxi() {
  const messageElement = document.getElementById('registrationMessageTaxi');
  if (messageElement) {
    messageElement.style.display = 'none';
    messageElement.textContent = '';
  }
}

function resetErrorsTaxi() {
  registerClientPhoneTaxi.classList.remove("error");
  registerClientNameTaxi.classList.remove("error");
  registerClientSurnameTaxi.classList.remove("error");
  registerClientPasswordTaxi.classList.remove("error");
  registerRulesCheckTaxi.classList.remove("error");
  clearRegisterTaxiPhotoErrors();
}

function setLoadingTaxi(loading) {
  if (loading) {
    registerButtonTaxi.disabled = true;
    registerButtonTaxi.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Регистрация...';
  } else {
    registerButtonTaxi.disabled = false;
    registerButtonTaxi.innerHTML = 'Зарегистрироваться';
  }
}

// Обновляем обработчик ошибок сервера
function handleServerError_registartionTaxi(result) {
  switch (result.error) {
    case 'phone_format':
      registerClientPhoneTaxi.classList.add("error");
      showErrorTaxi("Неверный формат телефона");
      break;
    case 'name_required':
      registerClientNameTaxi.classList.add("error");
      showErrorTaxi("Имя обязательно для заполнения");
      break;
    case 'surname_required':
      registerClientSurnameTaxi.classList.add("error");
      showErrorTaxi("Фамилия обязательна для заполнения");
      break;
    case 'password_length':
      registerClientPasswordTaxi.classList.add("error");
      showErrorTaxi("Пароль должен содержать минимум 6 символов");
      break;
    case 'terms_not_accepted':
      registerRulesCheckTaxi.classList.add("error");
      showErrorTaxi("Необходимо согласие с правилами");
      break;
    case 'phone_exists':
      registerClientPhoneTaxi.classList.add("error");
      showErrorTaxi("Пользователь с таким телефоном уже существует");
      break;
    case 'car_year_invalid':
      carYearTaxi.classList.add("error");
      showErrorTaxi("Неверный год выпуска автомобиля");
      break;
    case 'car_number_invalid':
      carNumberTaxi.classList.add("error");
      showErrorTaxi("Неверный формат номера автомобиля");
      break;
    case 'tech_passport_invalid':
      techPassportTaxi.classList.add("error");
      showErrorTaxi("Неверный формат техпаспорта");
      break;
    case 'car_name_required':
      showErrorTaxi("Название автомобиля обязательна для заполнения");
      break;
    case 'driver_license_invalid':
      driverLicenseTaxi.classList.add("error");
      showErrorTaxi("Неверный формат водительского удостоверения");
      break;
    case 'photo_required':
      showErrorTaxi("Все фотографии обязательны для заполнения");
      break;
    case 'car_number_exists':
      showErrorTaxi("Водитель с таким номерным знаком уже существует");
      break;
    case 'server_error':
      showErrorTaxi("Внутренняя ошибка сервера. Попробуйте позже.");
      break;
    default:
      showErrorTaxi(result.message || "Произошла ошибка при регистрации");
  }
}

function formatTaxiInput(input) {
  const id = input.id;
  let value = input.value;

  if (id === 'carYearTaxi') {
    // Только 4 цифры
    input.value = value.replace(/\D/g,'').slice(0,4);
  } 
  else if (id === 'registerNameTaxi' || id === 'registerSurnameTaxi') {
    // Убираем всё кроме букв, но без перевода в верхний регистр
    input.value = value.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '');
  }
  else if (id === 'techPassportTaxi' || id === 'driverLicenseTaxi' || id === 'carNumberTaxi') {
    // Только для этих полей переводим в верхний регистр
    value = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    
    if (id === 'carNumberTaxi') {
      // Формат 00 XX 000
      let formatted = '';
      const digits = value.match(/^\d{0,2}/)?.[0] || '';
      formatted += digits;
      const letters = value.slice(digits.length).match(/^[A-Z]{0,2}/)?.[0] || '';
      if (letters) formatted += ' ' + letters;
      const lastDigits = value.slice(digits.length + letters.length).match(/^\d{0,3}/)?.[0] || '';
      if (lastDigits) formatted += ' ' + lastDigits;
      input.value = formatted;
    } else {
      // techPassportTaxi / driverLicenseTaxi: XX № 000000
      const letters = value.replace(/[0-9]/g,'').slice(0,2);
      const numbers = value.replace(/[A-Z]/g,'').slice(0,6);

      if (letters.length === 2) {
          // вставляем " № " сразу после двух букв
          input.value = letters + ' № ' + numbers;
      } else {
          input.value = letters;
      }
    }

  }
}



carNumberTaxi.addEventListener('input', (e) => {
  let value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  let formatted = '';

  // Этап 1: первые 2 цифры
  const firstDigits = value.match(/^\d{0,2}/)?.[0] || '';
  formatted += firstDigits;

  // Этап 2: следующие 2 буквы, только если первые 2 цифры введены
  let letters = '';
  if (firstDigits.length === 2) {
    letters = value.slice(2).match(/^[A-Z]{0,2}/)?.[0] || '';
    if (letters) formatted += ' ' + letters;
  }

  // Этап 3: последние 3 цифры, только если 2 буквы введены
  let lastDigits = '';
  if (letters.length === 2) {
    lastDigits = value.slice(4).match(/^\d{0,3}/)?.[0] || '';
    if (lastDigits) formatted += ' ' + lastDigits;
  }

  e.target.value = formatted;
});

// Навешиваем обработчик на все поля
['carYearTaxi','techPassportTaxi','driverLicenseTaxi', 'registerNameTaxi', 'registerSurnameTaxi'].forEach(id => {
  const input = document.getElementById(id);
  if (input) {
    input.addEventListener('input', () => formatTaxiInput(input));
  }
});


// Обработчик для кнопки "Зарегистрироваться"
document.querySelector('.taxi-to-login-redirect-btn').addEventListener('click', () => {
    // Переключение на экран регистрации
    window.taxiApp.showScreen('login-screen');
});