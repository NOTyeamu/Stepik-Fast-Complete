using System;

class Program
{
    static void Main()
    {
       int score = int.Parse(Console.ReadLine());
        
        if (score >= 90 && score <= 100)
        {
            Console.WriteLine("Отлично");
        }
        else if (score >= 75 && score <= 89)
        {
            Console.WriteLine("Хорошо");
        }
        else if (score >= 60 && score <= 74)
        {
            Console.WriteLine("Удовлетворительно");
        }
        else if (score >= 0 && score <= 59)
        {
            Console.WriteLine("Неудовлетворительно");
        }
        else
        {
            Console.WriteLine("Ошибка ввода");
        }
    }
}