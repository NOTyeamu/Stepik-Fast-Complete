using System;

class Program
{
    static void Main()
    {
        int chislo = int.Parse(Console.ReadLine());
        bool prostoe = true;

        for (int i = 2; i * i <= chislo; i++)
        {
            if (chislo % i == 0)
            {
                prostoe = false;
                break;
            }
        }

        if (prostoe)
        {
            Console.WriteLine("Простое число");
        }
        else
        {
            Console.WriteLine("Не является простым числом");
        }
    }
}